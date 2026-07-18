//! Native Kademlia rendezvous for globally discovering Sent coin citations.
//!
//! The DHT is deliberately an index, never a content store or trust oracle.
//! A record at `H` is a bounded set of `{eventId, relayUrl}` pointers. The
//! webview verifies every pointer against the signed carrying event, its `q`
//! edge, and the cited Coin's body/`x` before surfacing it.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::IpAddr;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{stream::FuturesUnordered, StreamExt};
use libp2p::connection_limits;
use libp2p::identify;
use libp2p::identity::Keypair;
use libp2p::kad::{
    self,
    store::{MemoryStore, MemoryStoreConfig, RecordStore},
    GetRecordOk, Mode, Quorum, Record, StoreInserts,
};
use libp2p::multiaddr::Protocol;
use libp2p::swarm::SwarmEvent;
use libp2p::{Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{interval_at, timeout, Instant};

const IDENTITY_FILENAME: &str = "zine-kademlia-identity.pb";
const OWNED_POINTERS_FILENAME: &str = "zine-kademlia-pointers.json";
const RECORD_PROTOCOL: &str = "/zine/rendezvous/kad/1.0.0";
const RECORD_KEY_PREFIX: &str = "/zine/rendezvous/1/";
const IDENTIFY_PROTOCOL: &str = "/zine/rendezvous/id/1.0.0";
const DEFAULT_LISTEN_ADDRESS: &str = "/ip4/0.0.0.0/tcp/0";
const REPLICATION_FACTOR: usize = 8;
const RECORD_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const REPLICATION_INTERVAL: Duration = Duration::from_secs(60 * 60);
const PUBLICATION_INTERVAL: Duration = Duration::from_secs(12 * 60 * 60);
const QUERY_TIMEOUT: Duration = Duration::from_secs(12);
const LOOKUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(18);
const PUBLISH_COMMAND_TIMEOUT: Duration = Duration::from_secs(28);
const MAX_POINTERS_PER_COORDINATE: usize = 64;
const MAX_OWNED_COORDINATES: usize = 2_048;
const MAX_RELAY_URL_BYTES: usize = 256;
const MAX_RECORD_BYTES: usize = 12 * 1024;
const MAX_OWNED_POINTER_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_STARTUP_REPUBLISH_QUERIES: usize = 4;
const MAX_REMOTE_RECORDS: usize = 1_024;
const MAX_PENDING_PERSISTENCE: usize = 64;
const MAX_PENDING_INCOMING_CONNECTIONS: u32 = 32;
const MAX_PENDING_OUTGOING_CONNECTIONS: u32 = 32;
const MAX_ESTABLISHED_INCOMING_CONNECTIONS: u32 = 96;
const MAX_ESTABLISHED_OUTGOING_CONNECTIONS: u32 = 64;
const MAX_ESTABLISHED_CONNECTIONS: u32 = 128;
const MAX_CONNECTIONS_PER_PEER: u32 = 2;
const IDLE_CONNECTION_TIMEOUT: Duration = Duration::from_secs(90);
const LISTENER_START_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_IDENTITY_BYTES: u64 = 4 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendezvousPointer {
    pub event_id: String,
    pub relay_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct PointerRecord {
    version: u8,
    coordinate: String,
    pointers: Vec<RendezvousPointer>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedPointerFile {
    version: u8,
    records: BTreeMap<String, Vec<RendezvousPointer>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KademliaStartConfig {
    #[serde(default)]
    bootstrap_peers: Vec<String>,
    listen_address: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KademliaStatus {
    running: bool,
    peer_id: String,
    listeners: Vec<String>,
    connected_peers: usize,
    routing_peers: usize,
    stored_coordinates: usize,
    last_error: Option<String>,
}

#[derive(Default)]
pub struct KademliaRuntime(tokio::sync::Mutex<Option<KademliaClient>>);

#[derive(Clone)]
struct KademliaClient {
    sender: mpsc::Sender<Command>,
}

enum Command {
    Publish {
        coordinate: String,
        pointer: RendezvousPointer,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Lookup {
        coordinate: String,
        reply: oneshot::Sender<Result<Vec<RendezvousPointer>, String>>,
    },
    Status {
        reply: oneshot::Sender<KademliaStatus>,
    },
    Stop {
        reply: oneshot::Sender<()>,
    },
}

#[derive(libp2p::swarm::NetworkBehaviour)]
struct ZineBehaviour {
    kad: kad::Behaviour<MemoryStore>,
    identify: identify::Behaviour,
    connection_limits: connection_limits::Behaviour,
}

enum PendingGet {
    Publish {
        coordinate: String,
        pointer: RendezvousPointer,
        pointers: BTreeSet<RendezvousPointer>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Lookup {
        coordinate: String,
        pointers: BTreeSet<RendezvousPointer>,
        reply: oneshot::Sender<Result<Vec<RendezvousPointer>, String>>,
    },
    Republish {
        coordinate: String,
        pointers: BTreeSet<RendezvousPointer>,
    },
}

enum PendingPut {
    Publish(oneshot::Sender<Result<(), String>>),
    Republish { coordinate: String },
}

struct PendingPersist {
    coordinate: String,
    pointer: RendezvousPointer,
    reply: oneshot::Sender<Result<(), String>>,
}

type PersistResult = Result<Vec<RendezvousPointer>, String>;

struct EventLoop {
    swarm: Swarm<ZineBehaviour>,
    commands: mpsc::Receiver<Command>,
    pending_gets: HashMap<kad::QueryId, PendingGet>,
    pending_puts: HashMap<kad::QueryId, PendingPut>,
    pending_persists: VecDeque<PendingPersist>,
    persistence_tasks: FuturesUnordered<JoinHandle<PersistResult>>,
    republish_queue: VecDeque<String>,
    republish_pending: BTreeSet<String>,
    republish_in_flight: usize,
    owned: BTreeMap<String, Vec<RendezvousPointer>>,
    owned_path: PathBuf,
    last_error: Option<String>,
}

impl KademliaClient {
    async fn publish(&self, coordinate: String, pointer: RendezvousPointer) -> Result<(), String> {
        let (reply, receive) = oneshot::channel();
        self.sender
            .send(Command::Publish {
                coordinate,
                pointer,
                reply,
            })
            .await
            .map_err(|_| "Kademlia task is not running".to_string())?;
        timeout(PUBLISH_COMMAND_TIMEOUT, receive)
            .await
            .map_err(|_| "Kademlia publish timed out".to_string())?
            .map_err(|_| "Kademlia task stopped during publish".to_string())?
    }

    async fn lookup(&self, coordinate: String) -> Result<Vec<RendezvousPointer>, String> {
        let (reply, receive) = oneshot::channel();
        self.sender
            .send(Command::Lookup { coordinate, reply })
            .await
            .map_err(|_| "Kademlia task is not running".to_string())?;
        timeout(LOOKUP_COMMAND_TIMEOUT, receive)
            .await
            .map_err(|_| "Kademlia lookup timed out".to_string())?
            .map_err(|_| "Kademlia task stopped during lookup".to_string())?
    }

    async fn status(&self) -> Result<KademliaStatus, String> {
        let (reply, receive) = oneshot::channel();
        self.sender
            .send(Command::Status { reply })
            .await
            .map_err(|_| "Kademlia task is not running".to_string())?;
        timeout(Duration::from_secs(2), receive)
            .await
            .map_err(|_| "Kademlia status timed out".to_string())?
            .map_err(|_| "Kademlia task stopped during status".to_string())
    }

    async fn stop(&self) {
        let (reply, receive) = oneshot::channel();
        if self.sender.send(Command::Stop { reply }).await.is_ok() {
            // Reset may delete the persistence files immediately after this
            // returns, so wait for any active blocking write to finish.
            let _ = receive.await;
        }
    }
}

impl EventLoop {
    async fn run(mut self) {
        self.fill_republish_window();
        let mut publication_timer =
            interval_at(Instant::now() + PUBLICATION_INTERVAL, PUBLICATION_INTERVAL);
        let mut stop_reply = None;
        loop {
            tokio::select! {
                command = self.commands.recv() => {
                    match command {
                        Some(Command::Publish { coordinate, pointer, reply }) => {
                            self.begin_publish(coordinate, pointer, reply);
                        }
                        Some(Command::Lookup { coordinate, reply }) => {
                            self.begin_lookup(coordinate, reply);
                        }
                        Some(Command::Status { reply }) => {
                            let _ = reply.send(self.status());
                        }
                        Some(Command::Stop { reply }) => {
                            stop_reply = Some(reply);
                            break;
                        }
                        None => break,
                    }
                }
                persisted = self.persistence_tasks.next(), if !self.persistence_tasks.is_empty() => {
                    if let Some(result) = persisted {
                        self.finish_persist(result, true);
                    }
                }
                _ = publication_timer.tick() => self.enqueue_republish_cycle(),
                event = self.swarm.select_next_some() => self.handle_swarm_event(event),
            }
        }

        if let Some(result) = self.persistence_tasks.next().await {
            self.finish_persist(result, false);
        }
        for pending in self.pending_persists.drain(..) {
            let _ = pending
                .reply
                .send(Err("Kademlia task stopped before persistence".to_string()));
        }
        for (_, pending) in self.pending_gets.drain() {
            match pending {
                PendingGet::Publish { reply, .. } => {
                    let _ = reply.send(Err("Kademlia task stopped".to_string()));
                }
                PendingGet::Lookup { reply, .. } => {
                    let _ = reply.send(Err("Kademlia task stopped".to_string()));
                }
                PendingGet::Republish { .. } => {}
            }
        }
        for (_, pending) in self.pending_puts.drain() {
            if let PendingPut::Publish(reply) = pending {
                let _ = reply.send(Err("Kademlia task stopped".to_string()));
            }
        }
        if let Some(reply) = stop_reply {
            let _ = reply.send(());
        }
    }

    fn begin_publish(
        &mut self,
        coordinate: String,
        pointer: RendezvousPointer,
        reply: oneshot::Sender<Result<(), String>>,
    ) {
        if self.pending_persists.len() >= MAX_PENDING_PERSISTENCE {
            let _ = reply.send(Err("Kademlia persistence queue is full".to_string()));
            return;
        }
        self.pending_persists.push_back(PendingPersist {
            coordinate,
            pointer,
            reply,
        });
        self.start_next_persist();
    }

    fn start_next_persist(&mut self) {
        if !self.persistence_tasks.is_empty() {
            return;
        }
        let Some(pending) = self.pending_persists.front() else {
            return;
        };
        let path = self.owned_path.clone();
        let coordinate = pending.coordinate.clone();
        let pointer = pending.pointer.clone();
        self.persistence_tasks
            .push(tokio::task::spawn_blocking(move || {
                persist_owned_pointer(&path, &coordinate, pointer)
            }));
    }

    fn finish_persist(
        &mut self,
        result: Result<PersistResult, tokio::task::JoinError>,
        continue_publish: bool,
    ) {
        let Some(pending) = self.pending_persists.pop_front() else {
            self.last_error = Some("Kademlia persistence completed without a request".to_string());
            return;
        };
        let result = result
            .map_err(|error| format!("Kademlia persistence task failed: {error}"))
            .and_then(|result| result);
        match result {
            Ok(pointers) if continue_publish => {
                self.owned.insert(pending.coordinate.clone(), pointers);
                self.begin_publish_get(pending);
            }
            Ok(pointers) => {
                self.owned.insert(pending.coordinate, pointers);
                let _ = pending
                    .reply
                    .send(Err("Kademlia task stopped after persistence".to_string()));
            }
            Err(error) => {
                self.last_error = Some(error.clone());
                let _ = pending.reply.send(Err(error));
            }
        }
        if continue_publish {
            self.start_next_persist();
        }
    }

    fn begin_publish_get(&mut self, pending: PendingPersist) {
        let id = self
            .swarm
            .behaviour_mut()
            .kad
            .get_record(record_key(&pending.coordinate));
        self.pending_gets.insert(
            id,
            PendingGet::Publish {
                coordinate: pending.coordinate,
                pointer: pending.pointer,
                pointers: BTreeSet::new(),
                reply: pending.reply,
            },
        );
    }

    fn begin_lookup(
        &mut self,
        coordinate: String,
        reply: oneshot::Sender<Result<Vec<RendezvousPointer>, String>>,
    ) {
        let id = self
            .swarm
            .behaviour_mut()
            .kad
            .get_record(record_key(&coordinate));
        self.pending_gets.insert(
            id,
            PendingGet::Lookup {
                coordinate,
                pointers: BTreeSet::new(),
                reply,
            },
        );
    }

    fn fill_republish_window(&mut self) {
        while self.republish_in_flight < MAX_STARTUP_REPUBLISH_QUERIES {
            let Some(coordinate) = self.republish_queue.pop_front() else {
                break;
            };
            let id = self
                .swarm
                .behaviour_mut()
                .kad
                .get_record(record_key(&coordinate));
            self.pending_gets.insert(
                id,
                PendingGet::Republish {
                    coordinate,
                    pointers: BTreeSet::new(),
                },
            );
            self.republish_in_flight += 1;
        }
    }

    fn enqueue_republish_cycle(&mut self) {
        for coordinate in self.owned.keys() {
            if self.republish_pending.insert(coordinate.clone()) {
                self.republish_queue.push_back(coordinate.clone());
            }
        }
        self.fill_republish_window();
    }

    fn handle_swarm_event(&mut self, event: SwarmEvent<ZineBehaviourEvent>) {
        match event {
            SwarmEvent::Behaviour(ZineBehaviourEvent::Kad(
                kad::Event::OutboundQueryProgressed {
                    id,
                    result: kad::QueryResult::GetRecord(result),
                    step,
                    ..
                },
            )) => {
                if let Ok(GetRecordOk::FoundRecord(peer_record)) = &result {
                    if let Some(pending) = self.pending_gets.get_mut(&id) {
                        merge_record_into_pending(pending, &peer_record.record.value);
                    }
                } else if let Err(error) = &result {
                    self.last_error = Some(error.to_string());
                }
                if step.last || result.is_err() {
                    self.finish_get(id);
                }
            }
            SwarmEvent::Behaviour(ZineBehaviourEvent::Kad(
                kad::Event::OutboundQueryProgressed {
                    id,
                    result: kad::QueryResult::PutRecord(result),
                    step,
                    ..
                },
            )) if step.last || result.is_err() => {
                if let Some(pending) = self.pending_puts.remove(&id) {
                    // N(8) forces libp2p to run the complete closest-peer Put
                    // instead of returning after the first ACK. A genuinely
                    // smaller network then reports QuorumFailed after all
                    // discovered peers were attempted; any non-empty success
                    // set is a usable partial publication and later explicit
                    // merge-before-republish cycles repair the shortfall.
                    let outcome = match result {
                        Ok(_) => Ok(()),
                        Err(kad::PutRecordError::QuorumFailed {
                            quorum, success, ..
                        }) if !success.is_empty() => {
                            self.last_error = Some(format!(
                                "Kademlia pointer set reached {}/{} requested replicas; retrying on the next publication cycle",
                                success.len(),
                                quorum,
                            ));
                            Ok(())
                        }
                        Err(error) => Err(format!(
                            "Kademlia replicas rejected the pointer set: {error}"
                        )),
                    };
                    if let Err(error) = &outcome {
                        self.last_error = Some(error.clone());
                    }
                    match pending {
                        PendingPut::Publish(reply) => {
                            let _ = reply.send(outcome);
                        }
                        PendingPut::Republish { coordinate } => {
                            self.finish_republish(coordinate);
                        }
                    }
                }
            }
            SwarmEvent::Behaviour(ZineBehaviourEvent::Kad(kad::Event::InboundRequest {
                request:
                    kad::InboundRequest::PutRecord {
                        record: Some(record),
                        ..
                    },
            })) => {
                if let Err(error) = store_inbound_record(
                    self.swarm.behaviour_mut().kad.store_mut(),
                    &self.owned,
                    record,
                ) {
                    self.last_error = Some(error);
                }
            }
            SwarmEvent::Behaviour(ZineBehaviourEvent::Identify(identify::Event::Received {
                peer_id,
                info,
                ..
            })) => {
                for address in info.listen_addrs {
                    self.swarm
                        .behaviour_mut()
                        .kad
                        .add_address(&peer_id, address);
                }
            }
            SwarmEvent::OutgoingConnectionError { error, .. } => {
                self.last_error = Some(error.to_string());
            }
            SwarmEvent::ListenerError { error, .. } => {
                self.last_error = Some(error.to_string());
            }
            _ => {}
        }
    }

    fn finish_get(&mut self, id: kad::QueryId) {
        let Some(mut pending) = self.pending_gets.remove(&id) else {
            return;
        };
        let coordinate = match &pending {
            PendingGet::Publish { coordinate, .. }
            | PendingGet::Lookup { coordinate, .. }
            | PendingGet::Republish { coordinate, .. } => coordinate.clone(),
        };
        merge_owned_into_pending(&mut pending, self.owned.get(&coordinate));

        match pending {
            PendingGet::Lookup {
                pointers, reply, ..
            } => {
                let _ = reply.send(Ok(merged_bounded_pointers(
                    pointers,
                    self.owned.get(&coordinate).map(Vec::as_slice),
                )));
            }
            PendingGet::Publish {
                pointer,
                pointers,
                reply,
                ..
            } => {
                let owned = self.owned.get(&coordinate).cloned().unwrap_or_default();
                debug_assert!(owned.contains(&pointer));
                match put_pointer_record(&mut self.swarm, &coordinate, pointers, &owned) {
                    Ok(Some(query_id)) => {
                        self.pending_puts
                            .insert(query_id, PendingPut::Publish(reply));
                    }
                    Ok(None) => {
                        let _ = reply.send(Ok(()));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            PendingGet::Republish { pointers, .. } => {
                let owned = self.owned.get(&coordinate).cloned().unwrap_or_default();
                match put_pointer_record(&mut self.swarm, &coordinate, pointers, &owned) {
                    Ok(Some(query_id)) => {
                        self.pending_puts
                            .insert(query_id, PendingPut::Republish { coordinate });
                    }
                    Ok(None) => self.finish_republish(coordinate),
                    Err(error) => {
                        self.last_error = Some(error);
                        self.finish_republish(coordinate);
                    }
                }
            }
        }
    }

    fn finish_republish(&mut self, coordinate: String) {
        self.republish_in_flight = self.republish_in_flight.saturating_sub(1);
        self.republish_pending.remove(&coordinate);
        self.fill_republish_window();
    }

    fn status(&mut self) -> KademliaStatus {
        let routing_peers = self
            .swarm
            .behaviour_mut()
            .kad
            .kbuckets()
            .map(|bucket| bucket.iter().count())
            .sum();
        KademliaStatus {
            running: true,
            peer_id: self.swarm.local_peer_id().to_string(),
            listeners: self.swarm.listeners().map(ToString::to_string).collect(),
            connected_peers: self.swarm.connected_peers().count(),
            routing_peers,
            stored_coordinates: self.owned.len(),
            last_error: self.last_error.clone(),
        }
    }
}

fn merge_record_into_pending(pending: &mut PendingGet, bytes: &[u8]) {
    let coordinate = match pending {
        PendingGet::Publish { coordinate, .. }
        | PendingGet::Lookup { coordinate, .. }
        | PendingGet::Republish { coordinate, .. } => coordinate,
    };
    let Ok(record) = parse_pointer_record(bytes, coordinate) else {
        return;
    };
    let pointers = match pending {
        PendingGet::Publish { pointers, .. }
        | PendingGet::Lookup { pointers, .. }
        | PendingGet::Republish { pointers, .. } => pointers,
    };
    pointers.extend(record.pointers);
}

fn merge_owned_into_pending(pending: &mut PendingGet, owned: Option<&Vec<RendezvousPointer>>) {
    let Some(owned) = owned else {
        return;
    };
    let pointers = match pending {
        PendingGet::Publish { pointers, .. }
        | PendingGet::Lookup { pointers, .. }
        | PendingGet::Republish { pointers, .. } => pointers,
    };
    pointers.extend(owned.iter().cloned());
}

fn put_pointer_record(
    swarm: &mut Swarm<ZineBehaviour>,
    coordinate: &str,
    pointers: BTreeSet<RendezvousPointer>,
    owned: &[RendezvousPointer],
) -> Result<Option<kad::QueryId>, String> {
    let value = encode_pointer_record(coordinate, pointers, owned)?;
    let mut record = Record::new(record_key(coordinate), value);
    let known_peers = routing_peer_count(swarm);
    if known_peers == 0 {
        record.publisher = Some(*swarm.local_peer_id());
        swarm
            .behaviour_mut()
            .kad
            .store_mut()
            .put(record)
            .map_err(|error| format!("could not store local Kademlia pointer set: {error}"))?;
        return Ok(None);
    }
    let quorum = publication_quorum(known_peers).expect("a non-empty routing table has a quorum");
    swarm
        .behaviour_mut()
        .kad
        .put_record(record, quorum)
        .map(Some)
        .map_err(|error| format!("could not store Kademlia pointer set: {error}"))
}

fn routing_peer_count(swarm: &mut Swarm<ZineBehaviour>) -> usize {
    swarm
        .behaviour_mut()
        .kad
        .kbuckets()
        .map(|bucket| bucket.iter().count())
        .sum()
}

fn publication_quorum(known_peers: usize) -> Option<Quorum> {
    (known_peers > 0).then(|| {
        // libp2p evaluates N against the configured replication factor, so
        // N(8) makes the query attempt the complete closest-peer set instead
        // of returning after the first ACK. The terminal handler accepts a
        // non-empty partial success only after that full attempt finishes.
        Quorum::N(
            NonZeroUsize::new(REPLICATION_FACTOR)
                .expect("the rendezvous replication factor is non-zero"),
        )
    })
}

fn record_key(coordinate: &str) -> kad::RecordKey {
    kad::RecordKey::new(&format!("{RECORD_KEY_PREFIX}{coordinate}"))
}

fn coordinate_from_record_key(key: &kad::RecordKey) -> Result<String, String> {
    let key = std::str::from_utf8(key.as_ref())
        .map_err(|_| "Kademlia rendezvous record key is not UTF-8".to_string())?;
    let coordinate = key
        .strip_prefix(RECORD_KEY_PREFIX)
        .ok_or_else(|| "Kademlia rendezvous record has the wrong key prefix".to_string())?;
    validate_coordinate(coordinate)?;
    if key != format!("{RECORD_KEY_PREFIX}{coordinate}") {
        return Err("Kademlia rendezvous record key is not canonical".to_string());
    }
    Ok(coordinate.to_string())
}

fn remote_record_count(
    store: &MemoryStore,
    owned: &BTreeMap<String, Vec<RendezvousPointer>>,
) -> usize {
    store
        .records()
        .filter(|record| {
            coordinate_from_record_key(&record.key)
                .map(|coordinate| !owned.contains_key(&coordinate))
                .unwrap_or(true)
        })
        .count()
}

fn store_inbound_record(
    store: &mut MemoryStore,
    owned: &BTreeMap<String, Vec<RendezvousPointer>>,
    mut record: Record,
) -> Result<(), String> {
    let coordinate = coordinate_from_record_key(&record.key)?;
    let incoming = parse_pointer_record(&record.value, &coordinate)?;
    let is_existing = store.get(&record.key).is_some();
    let is_owned = owned.contains_key(&coordinate);
    if !is_existing && !is_owned && remote_record_count(store, owned) >= MAX_REMOTE_RECORDS {
        return Err("Kademlia remote-record cache is full".to_string());
    }

    let mut merged = incoming.pointers.into_iter().collect::<BTreeSet<_>>();
    if let Some(existing) = store.get(&record.key) {
        if let Ok(existing) = parse_pointer_record(&existing.value, &coordinate) {
            merged.extend(existing.pointers);
        }
    }
    let reserved = owned
        .get(&coordinate)
        .map(Vec::as_slice)
        .unwrap_or_default();
    record.value = encode_pointer_record(&coordinate, merged, reserved)?;
    store
        .put(record)
        .map_err(|error| format!("could not retain validated Kademlia record: {error}"))
}

fn encode_pointer_record(
    coordinate: &str,
    pointers: BTreeSet<RendezvousPointer>,
    owned: &[RendezvousPointer],
) -> Result<Vec<u8>, String> {
    validate_coordinate(coordinate)?;
    if owned.len() > MAX_POINTERS_PER_COORDINATE {
        return Err("too many locally owned Kademlia pointers".to_string());
    }
    let mut ordered = Vec::with_capacity(MAX_POINTERS_PER_COORDINATE);
    let mut seen = BTreeSet::new();
    for pointer in owned {
        validate_pointer(pointer)?;
        if seen.insert(pointer.clone()) {
            ordered.push(pointer.clone());
        }
    }
    let owned_count = ordered.len();
    for pointer in pointers {
        validate_pointer(&pointer)?;
        if !seen.insert(pointer.clone()) {
            continue;
        }
        if ordered.len() >= MAX_POINTERS_PER_COORDINATE {
            break;
        }
        ordered.push(pointer);
    }

    loop {
        let bytes = serde_json::to_vec(&PointerRecord {
            version: 1,
            coordinate: coordinate.to_string(),
            pointers: ordered.clone(),
        })
        .map_err(|error| format!("serialize Kademlia pointer set: {error}"))?;
        if bytes.len() <= MAX_RECORD_BYTES {
            return Ok(bytes);
        }
        if ordered.len() <= owned_count {
            return Err("Kademlia pointer set exceeds the record-size limit".to_string());
        }
        ordered.pop();
    }
}

fn parse_pointer_record(bytes: &[u8], coordinate: &str) -> Result<PointerRecord, String> {
    if bytes.len() > MAX_RECORD_BYTES {
        return Err("Kademlia pointer record is too large".to_string());
    }
    let mut record: PointerRecord = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid Kademlia pointer record: {error}"))?;
    if record.version != 1 || record.coordinate != coordinate {
        return Err("Kademlia pointer record has the wrong version or coordinate".to_string());
    }
    let mut pointers = BTreeSet::new();
    for pointer in record.pointers {
        validate_pointer(&pointer)?;
        pointers.insert(pointer);
    }
    record.pointers = bounded_pointers(pointers);
    Ok(record)
}

fn bounded_pointers(pointers: BTreeSet<RendezvousPointer>) -> Vec<RendezvousPointer> {
    merged_bounded_pointers(pointers, None)
}

fn merged_bounded_pointers(
    pointers: BTreeSet<RendezvousPointer>,
    owned: Option<&[RendezvousPointer]>,
) -> Vec<RendezvousPointer> {
    let mut result = Vec::with_capacity(MAX_POINTERS_PER_COORDINATE);
    let mut seen = BTreeSet::new();
    for pointer in owned.unwrap_or_default() {
        if seen.insert(pointer.clone()) {
            result.push(pointer.clone());
        }
    }
    for pointer in pointers {
        if result.len() >= MAX_POINTERS_PER_COORDINATE {
            break;
        }
        if seen.insert(pointer.clone()) {
            result.push(pointer);
        }
    }
    result
}

fn validate_coordinate(coordinate: &str) -> Result<(), String> {
    if coordinate.len() == 64
        && coordinate
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("rendezvous coordinate must be 64 lowercase hex characters".to_string())
    }
}

fn validate_pointer(pointer: &RendezvousPointer) -> Result<(), String> {
    validate_coordinate(&pointer.event_id)
        .map_err(|_| "rendezvous event id must be 64 lowercase hex characters".to_string())?;
    if pointer.relay_url.len() > MAX_RELAY_URL_BYTES {
        return Err("rendezvous relay URL is too long".to_string());
    }
    let url = reqwest::Url::parse(&pointer.relay_url)
        .map_err(|_| "rendezvous relay URL is invalid".to_string())?;
    if url.scheme() != "ws" && url.scheme() != "wss" {
        return Err("rendezvous relay URL must use ws or wss".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "rendezvous relay URL needs a host".to_string())?
        .to_ascii_lowercase();
    if !url.username().is_empty()
        || url.password().is_some()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".onion")
    {
        return Err("rendezvous relay must be stranger-readable and clearnet".to_string());
    }
    let ip_host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(&host);
    if let Ok(ip) = ip_host.parse::<IpAddr>() {
        let private = match ip {
            IpAddr::V4(ip) => is_private_ipv4(ip),
            IpAddr::V6(ip) => {
                ip.to_ipv4_mapped().is_some_and(is_private_ipv4)
                    || ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
                    || ip.is_multicast()
            }
        };
        if private {
            return Err("rendezvous relay must not be a private address".to_string());
        }
    }
    Ok(())
}

fn is_private_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
}

fn add_owned_pointer(
    owned: &mut BTreeMap<String, Vec<RendezvousPointer>>,
    coordinate: &str,
    pointer: RendezvousPointer,
) -> Result<(), String> {
    validate_coordinate(coordinate)?;
    validate_pointer(&pointer)?;
    if !owned.contains_key(coordinate) && owned.len() >= MAX_OWNED_COORDINATES {
        return Err("Kademlia owned-pointer index is full".to_string());
    }
    let mut entries = owned.get(coordinate).cloned().unwrap_or_default();
    if entries.contains(&pointer) {
        return Ok(());
    }
    entries.push(pointer.clone());
    let entries = trim_owned_pointers(coordinate, entries, Some(&pointer))?;
    owned.insert(coordinate.to_string(), entries);
    Ok(())
}

fn trim_owned_pointers(
    coordinate: &str,
    pointers: Vec<RendezvousPointer>,
    required: Option<&RendezvousPointer>,
) -> Result<Vec<RendezvousPointer>, String> {
    let mut pointers = pointers.into_iter().collect::<BTreeSet<_>>();
    loop {
        let ordered = pointers.iter().cloned().collect::<Vec<_>>();
        if ordered.len() <= MAX_POINTERS_PER_COORDINATE
            && encode_pointer_record(coordinate, BTreeSet::new(), &ordered).is_ok()
        {
            return Ok(ordered);
        }
        let removable = pointers
            .iter()
            .find(|pointer| required != Some(*pointer))
            .cloned()
            .ok_or_else(|| "locally owned Kademlia pointer exceeds record limits".to_string())?;
        pointers.remove(&removable);
    }
}

fn load_owned_pointers(path: &Path) -> Result<BTreeMap<String, Vec<RendezvousPointer>>, String> {
    let file = match OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BTreeMap::new());
        }
        Err(error) => {
            return Err(format!("read owned Kademlia pointers: {error}"));
        }
    };
    let metadata = file
        .metadata()
        .map_err(|error| format!("inspect owned Kademlia pointers: {error}"))?;
    if metadata.len() > MAX_OWNED_POINTER_FILE_BYTES as u64 {
        return Err("owned Kademlia pointer file exceeds its size limit".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_OWNED_POINTER_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read owned Kademlia pointers: {error}"))?;
    if bytes.len() > MAX_OWNED_POINTER_FILE_BYTES {
        return Err("owned Kademlia pointer file grew beyond its size limit".to_string());
    }
    let file: OwnedPointerFile = serde_json::from_slice(&bytes)
        .map_err(|error| format!("decode owned Kademlia pointers: {error}"))?;
    if file.version != 1 {
        return Err(format!(
            "owned Kademlia pointer file has unsupported version {}",
            file.version
        ));
    }
    if file.records.len() > MAX_OWNED_COORDINATES {
        return Err("owned Kademlia pointer file has too many coordinates".to_string());
    }

    for (coordinate, pointers) in &file.records {
        validate_coordinate(coordinate)
            .map_err(|error| format!("invalid owned Kademlia coordinate: {error}"))?;
        if pointers.is_empty() || pointers.len() > MAX_POINTERS_PER_COORDINATE {
            return Err(format!(
                "owned Kademlia coordinate {coordinate} has an invalid pointer count"
            ));
        }
        let distinct = pointers.iter().collect::<BTreeSet<_>>();
        if distinct.len() != pointers.len() {
            return Err(format!(
                "owned Kademlia coordinate {coordinate} contains duplicate pointers"
            ));
        }
        encode_pointer_record(coordinate, BTreeSet::new(), pointers)
            .map_err(|error| format!("invalid owned Kademlia coordinate {coordinate}: {error}"))?;
    }

    Ok(file.records)
}

fn persist_owned_pointers(
    path: &Path,
    owned: &BTreeMap<String, Vec<RendezvousPointer>>,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&OwnedPointerFile {
        version: 1,
        records: owned.clone(),
    })
    .map_err(|error| format!("serialize owned Kademlia pointers: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("write owned Kademlia pointers: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("replace owned Kademlia pointers: {error}"))
}

fn persist_owned_pointer(
    path: &Path,
    coordinate: &str,
    pointer: RendezvousPointer,
) -> PersistResult {
    let mut owned = load_owned_pointers(path)?;
    add_owned_pointer(&mut owned, coordinate, pointer)?;
    persist_owned_pointers(path, &owned)?;
    owned
        .remove(coordinate)
        .ok_or_else(|| "persisted Kademlia coordinate disappeared".to_string())
}

fn load_or_create_identity(path: &Path) -> Result<Keypair, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => return load_existing_identity(path, metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("inspect Kademlia identity: {error}")),
    }
    let key = Keypair::generate_ed25519();
    let bytes = key
        .to_protobuf_encoding()
        .map_err(|error| format!("encode Kademlia identity: {error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path)
                .map_err(|error| format!("inspect raced Kademlia identity: {error}"))?;
            return load_existing_identity(path, metadata);
        }
        Err(error) => return Err(format!("create Kademlia identity: {error}")),
    };
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("persist Kademlia identity: {error}"))?;
    drop(file);
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("verify Kademlia identity: {error}"))?;
    load_existing_identity(path, metadata)
}

fn load_existing_identity(path: &Path, metadata: fs::Metadata) -> Result<Keypair, String> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Kademlia identity must be a regular, non-symlink file".to_string());
    }
    if metadata.len() > MAX_IDENTITY_BYTES {
        return Err("Kademlia identity file is unexpectedly large".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return Err("Kademlia identity permissions must be 0600".to_string());
        }
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("open Kademlia identity safely: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = file
            .metadata()
            .map_err(|error| format!("inspect open Kademlia identity: {error}"))?;
        if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
            return Err("Kademlia identity changed while it was being opened".to_string());
        }
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_IDENTITY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read Kademlia identity: {error}"))?;
    if bytes.len() as u64 > MAX_IDENTITY_BYTES {
        return Err("Kademlia identity file grew beyond its size limit".to_string());
    }
    Keypair::from_protobuf_encoding(&bytes)
        .map_err(|error| format!("decode Kademlia identity: {error}"))
}

fn parse_bootstrap_peer(value: &str) -> Result<(PeerId, Multiaddr), String> {
    let mut address: Multiaddr = value
        .parse()
        .map_err(|_| format!("invalid bootstrap multiaddr: {value}"))?;
    let Some(Protocol::P2p(peer_id)) = address.pop() else {
        return Err(format!(
            "bootstrap multiaddr needs a trailing /p2p/<peer-id>: {value}"
        ));
    };
    if address.is_empty() {
        return Err(format!("bootstrap multiaddr needs a dial address: {value}"));
    }
    Ok((peer_id, address))
}

async fn wait_for_listener(swarm: &mut Swarm<ZineBehaviour>) -> Result<(), String> {
    timeout(LISTENER_START_TIMEOUT, async {
        loop {
            match swarm.select_next_some().await {
                SwarmEvent::NewListenAddr { .. } => return Ok(()),
                SwarmEvent::ListenerError { error, .. } => {
                    return Err(format!("Kademlia listener failed to start: {error}"));
                }
                SwarmEvent::ListenerClosed { reason, .. } => {
                    return Err(format!(
                        "Kademlia listener closed during startup: {reason:?}"
                    ));
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| "Kademlia listener did not become ready before timeout".to_string())?
}

async fn start_runtime(
    data_dir: PathBuf,
    config: KademliaStartConfig,
) -> Result<KademliaClient, String> {
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("create Kademlia data directory: {error}"))?;
    let key = load_or_create_identity(&data_dir.join(IDENTITY_FILENAME))?;
    let local_peer_id = PeerId::from(key.public());
    let owned_path = data_dir.join(OWNED_POINTERS_FILENAME);
    let owned = load_owned_pointers(&owned_path)?;

    let mut kad_config = kad::Config::new(StreamProtocol::new(RECORD_PROTOCOL));
    kad_config
        .set_replication_factor(
            NonZeroUsize::new(REPLICATION_FACTOR).expect("replication factor is non-zero"),
        )
        .set_query_timeout(QUERY_TIMEOUT)
        .set_record_ttl(Some(RECORD_TTL))
        .set_replication_interval(Some(REPLICATION_INTERVAL))
        // Record values are multi-writer sets. libp2p's automatic publication
        // republishes its last local value without first merging DHT replicas,
        // so the event loop performs the merge-before-Put publication cycle.
        .set_publication_interval(None)
        .set_record_filtering(StoreInserts::FilterBoth)
        .disjoint_query_paths(true);

    let store = MemoryStore::with_config(
        local_peer_id,
        MemoryStoreConfig {
            max_records: MAX_OWNED_COORDINATES + MAX_REMOTE_RECORDS,
            // MemoryStore rejects values whose length is >= this setting.
            max_value_bytes: MAX_RECORD_BYTES + 1,
            max_providers_per_key: REPLICATION_FACTOR,
            max_provided_keys: 0,
        },
    );
    let mut kad = kad::Behaviour::with_config(local_peer_id, store, kad_config);
    kad.set_mode(Some(Mode::Server));
    let identify = identify::Behaviour::new(
        identify::Config::new(IDENTIFY_PROTOCOL.to_string(), key.public())
            .with_agent_version(format!("zine/{}", env!("CARGO_PKG_VERSION"))),
    );
    let connection_limits = connection_limits::Behaviour::new(
        connection_limits::ConnectionLimits::default()
            .with_max_pending_incoming(Some(MAX_PENDING_INCOMING_CONNECTIONS))
            .with_max_pending_outgoing(Some(MAX_PENDING_OUTGOING_CONNECTIONS))
            .with_max_established_incoming(Some(MAX_ESTABLISHED_INCOMING_CONNECTIONS))
            .with_max_established_outgoing(Some(MAX_ESTABLISHED_OUTGOING_CONNECTIONS))
            .with_max_established(Some(MAX_ESTABLISHED_CONNECTIONS))
            .with_max_established_per_peer(Some(MAX_CONNECTIONS_PER_PEER)),
    );

    let mut swarm = SwarmBuilder::with_existing_identity(key)
        .with_tokio()
        .with_tcp(
            libp2p::tcp::Config::default(),
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )
        .map_err(|error| format!("configure Kademlia TCP transport: {error}"))?
        .with_dns()
        .map_err(|error| format!("configure Kademlia DNS transport: {error}"))?
        .with_behaviour(|_| ZineBehaviour {
            kad,
            identify,
            connection_limits,
        })
        .map_err(|error| format!("configure Kademlia behaviour: {error}"))?
        .with_swarm_config(|config| config.with_idle_connection_timeout(IDLE_CONNECTION_TIMEOUT))
        .build();

    let listen: Multiaddr = config
        .listen_address
        .as_deref()
        .filter(|address| !address.trim().is_empty())
        .unwrap_or(DEFAULT_LISTEN_ADDRESS)
        .parse()
        .map_err(|_| "invalid Kademlia listen multiaddr".to_string())?;
    swarm
        .listen_on(listen)
        .map_err(|error| format!("listen for Kademlia peers: {error}"))?;
    // `listen_on` only schedules the listener. Do not report configuration
    // success (or let the webview persist it) until the socket is actually
    // bound and advertised by the swarm.
    wait_for_listener(&mut swarm).await?;

    for value in config.bootstrap_peers {
        let (peer, address) = parse_bootstrap_peer(value.trim())?;
        swarm
            .behaviour_mut()
            .kad
            .add_address(&peer, address.clone());
        let dial_address = address.with(Protocol::P2p(peer));
        if let Err(error) = swarm.dial(dial_address) {
            return Err(format!("dial Kademlia bootstrap peer {peer}: {error}"));
        }
    }
    if swarm.behaviour_mut().kad.bootstrap().is_err() {
        // A first super-peer legitimately starts without an upstream peer.
        // It can still listen and become the bootstrap point for others.
    }

    let republish_queue = owned.keys().cloned().collect();
    let republish_pending = owned.keys().cloned().collect();
    let (sender, commands) = mpsc::channel(64);
    tauri::async_runtime::spawn(
        EventLoop {
            swarm,
            commands,
            pending_gets: HashMap::new(),
            pending_puts: HashMap::new(),
            pending_persists: VecDeque::new(),
            persistence_tasks: FuturesUnordered::new(),
            republish_queue,
            republish_pending,
            republish_in_flight: 0,
            owned,
            owned_path,
            last_error: None,
        }
        .run(),
    );
    Ok(KademliaClient { sender })
}

async fn runtime_client(runtime: &State<'_, KademliaRuntime>) -> Result<KademliaClient, String> {
    runtime
        .0
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Kademlia rendezvous is disabled".to_string())
}

#[tauri::command]
pub async fn kademlia_start(
    app: tauri::AppHandle,
    runtime: State<'_, KademliaRuntime>,
    config: KademliaStartConfig,
) -> Result<KademliaStatus, String> {
    let mut slot = runtime.0.lock().await;
    let existing = slot.clone();
    if let Some(existing) = existing {
        drop(slot);
        return existing.status().await;
    }
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("resolve Kademlia data directory: {error}"))?;
    let client = start_runtime(data_dir, config).await?;
    *slot = Some(client.clone());
    drop(slot);
    client.status().await
}

#[tauri::command]
pub async fn kademlia_stop(runtime: State<'_, KademliaRuntime>) -> Result<(), String> {
    // Keep start/stop serialized through shutdown. Otherwise a concurrent
    // start can open the identity and pointer files while the old event loop
    // still has a blocking persistence write in flight.
    let mut slot = runtime.0.lock().await;
    if let Some(client) = slot.take() {
        client.stop().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn kademlia_status(
    runtime: State<'_, KademliaRuntime>,
) -> Result<KademliaStatus, String> {
    let client = runtime.0.lock().await.clone();
    match client {
        Some(client) => client.status().await,
        None => Ok(KademliaStatus {
            running: false,
            peer_id: String::new(),
            listeners: Vec::new(),
            connected_peers: 0,
            routing_peers: 0,
            stored_coordinates: 0,
            last_error: None,
        }),
    }
}

#[tauri::command]
pub async fn kademlia_publish_pointer(
    runtime: State<'_, KademliaRuntime>,
    coordinate: String,
    pointer: RendezvousPointer,
) -> Result<(), String> {
    validate_coordinate(&coordinate)?;
    validate_pointer(&pointer)?;
    runtime_client(&runtime)
        .await?
        .publish(coordinate, pointer)
        .await
}

#[tauri::command]
pub async fn kademlia_lookup(
    runtime: State<'_, KademliaRuntime>,
    coordinate: String,
) -> Result<Vec<RendezvousPointer>, String> {
    validate_coordinate(&coordinate)?;
    runtime_client(&runtime).await?.lookup(coordinate).await
}

pub async fn reset_runtime(
    app: &tauri::AppHandle,
    runtime: &State<'_, KademliaRuntime>,
) -> Result<(), String> {
    // Factory reset owns the runtime slot until shutdown and deletion finish;
    // no replacement runtime may recreate files that this reset then removes.
    let mut slot = runtime.0.lock().await;
    if let Some(client) = slot.take() {
        client.stop().await;
    }
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("resolve Kademlia data directory: {error}"))?;
    for filename in [IDENTITY_FILENAME, OWNED_POINTERS_FILENAME] {
        let path = data_dir.join(filename);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("remove {}: {error}", path.display())),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const H: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn pointer(event_byte: char, relay: &str) -> RendezvousPointer {
        RendezvousPointer {
            event_id: std::iter::repeat_n(event_byte, 64).collect(),
            relay_url: relay.to_string(),
        }
    }

    #[test]
    fn pointer_records_round_trip_deduplicate_and_stay_bounded() {
        let mut pointers = BTreeSet::new();
        pointers.insert(pointer('b', "wss://relay.example/"));
        pointers.insert(pointer('b', "wss://relay.example/"));
        pointers.insert(pointer('c', "wss://relay.example/"));
        let encoded = encode_pointer_record(H, pointers, &[]).expect("encode valid record");
        let parsed = parse_pointer_record(&encoded, H).expect("parse valid record");
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.coordinate, H);
        assert_eq!(parsed.pointers.len(), 2);
        assert!(encoded.len() <= MAX_RECORD_BYTES);
    }

    #[test]
    fn a_new_publish_survives_a_full_remote_pointer_set() {
        let required = pointer('f', "wss://new.example/");
        let mut pointers = BTreeSet::new();
        for index in 0..MAX_POINTERS_PER_COORDINATE {
            pointers.insert(RendezvousPointer {
                event_id: format!("{index:064x}"),
                relay_url: "wss://relay.example/".to_string(),
            });
        }
        let bounded = merged_bounded_pointers(pointers, Some(std::slice::from_ref(&required)));
        assert_eq!(bounded.len(), MAX_POINTERS_PER_COORDINATE);
        assert!(bounded.contains(&required));
    }

    #[test]
    fn a_required_publish_survives_the_record_byte_limit() {
        let required = pointer('f', "wss://new.example/");
        let long_relay = format!("wss://relay.example/{}", "a".repeat(220));
        let pointers = (0..MAX_POINTERS_PER_COORDINATE)
            .map(|index| RendezvousPointer {
                event_id: format!("{index:064x}"),
                relay_url: long_relay.clone(),
            })
            .collect::<BTreeSet<_>>();
        let encoded = encode_pointer_record(H, pointers, std::slice::from_ref(&required))
            .expect("fit a valid record while retaining the new pointer");
        let parsed = parse_pointer_record(&encoded, H).expect("parse byte-bounded record");
        assert!(encoded.len() <= MAX_RECORD_BYTES);
        assert!(parsed.pointers.contains(&required));
        assert!(parsed.pointers.len() < MAX_POINTERS_PER_COORDINATE);
    }

    #[test]
    fn pointer_validation_rejects_private_onion_and_non_websocket_relays() {
        assert!(validate_pointer(&pointer('b', "ws://127.0.0.1:4869")).is_err());
        assert!(validate_pointer(&pointer('b', "wss://private.example.onion")).is_err());
        assert!(validate_pointer(&pointer('b', "https://relay.example")).is_err());
        assert!(validate_pointer(&pointer('b', "wss://secret@relay.example")).is_err());
        assert!(validate_pointer(&pointer('b', "ws://[::ffff:127.0.0.1]")).is_err());
        assert!(validate_pointer(&pointer('b', "ws://[::ffff:192.168.1.5]")).is_err());
        assert!(validate_pointer(&pointer('b', "wss://relay.example")).is_ok());
    }

    #[test]
    fn publication_requests_all_eight_replicas_once_any_peer_is_known() {
        assert!(publication_quorum(0).is_none());
        assert!(matches!(
            publication_quorum(1),
            Some(Quorum::N(value)) if value.get() == REPLICATION_FACTOR
        ));
        assert!(matches!(
            publication_quorum(REPLICATION_FACTOR),
            Some(Quorum::N(value)) if value.get() == REPLICATION_FACTOR
        ));
        assert!(matches!(
            publication_quorum(REPLICATION_FACTOR + 20),
            Some(Quorum::N(value)) if value.get() == REPLICATION_FACTOR
        ));
    }

    #[test]
    fn owned_pointer_index_keeps_one_exact_pointer_and_coordinate() {
        let mut owned = BTreeMap::new();
        let value = pointer('b', "wss://relay.example");
        add_owned_pointer(&mut owned, H, value.clone()).expect("first pointer");
        add_owned_pointer(&mut owned, H, value).expect("duplicate pointer");
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[H].len(), 1);
    }

    fn configured_store() -> MemoryStore {
        MemoryStore::with_config(
            PeerId::random(),
            MemoryStoreConfig {
                max_records: MAX_OWNED_COORDINATES + MAX_REMOTE_RECORDS,
                max_value_bytes: MAX_RECORD_BYTES + 1,
                max_providers_per_key: REPLICATION_FACTOR,
                max_provided_keys: 0,
            },
        )
    }

    fn valid_record(coordinate: &str, pointer: RendezvousPointer) -> Record {
        let pointers = BTreeSet::from([pointer]);
        let value = encode_pointer_record(coordinate, pointers, &[]).expect("valid record value");
        Record::new(record_key(coordinate), value)
    }

    #[test]
    fn inbound_store_rejects_non_protocol_records() {
        let mut store = configured_store();
        let owned = BTreeMap::new();
        let valid_value = encode_pointer_record(
            H,
            BTreeSet::from([pointer('b', "wss://relay.example")]),
            &[],
        )
        .expect("valid value");

        let wrong_key = Record::new(kad::RecordKey::new(&"/unrelated/key"), valid_value.clone());
        assert!(store_inbound_record(&mut store, &owned, wrong_key).is_err());

        let wrong_coordinate = Record::new(
            record_key("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            valid_value,
        );
        assert!(store_inbound_record(&mut store, &owned, wrong_coordinate).is_err());

        let oversized = Record::new(record_key(H), vec![b'x'; MAX_RECORD_BYTES + 1]);
        assert!(store_inbound_record(&mut store, &owned, oversized).is_err());

        let unknown_field =
            format!(r#"{{"version":1,"coordinate":"{H}","pointers":[],"surprise":true}}"#);
        let unknown_field = Record::new(record_key(H), unknown_field.into_bytes());
        assert!(store_inbound_record(&mut store, &owned, unknown_field).is_err());
        assert_eq!(store.records().count(), 0);
    }

    #[test]
    fn inbound_merge_never_evicts_a_locally_owned_pointer() {
        let local = pointer('f', "wss://local.example");
        let mut owned = BTreeMap::new();
        owned.insert(H.to_string(), vec![local.clone()]);
        let remote = (0..MAX_POINTERS_PER_COORDINATE)
            .map(|index| RendezvousPointer {
                event_id: format!("{index:064x}"),
                relay_url: "wss://remote.example".to_string(),
            })
            .collect::<BTreeSet<_>>();
        let value = encode_pointer_record(H, remote, &[]).expect("remote record");
        let mut store = configured_store();
        store_inbound_record(&mut store, &owned, Record::new(record_key(H), value))
            .expect("retain valid remote record");

        let stored = store.get(&record_key(H)).expect("stored merged record");
        let parsed = parse_pointer_record(&stored.value, H).expect("valid merged value");
        assert_eq!(parsed.pointers.len(), MAX_POINTERS_PER_COORDINATE);
        assert!(parsed.pointers.contains(&local));
    }

    #[test]
    fn remote_saturation_leaves_capacity_for_every_owned_coordinate() {
        let mut store = configured_store();
        let mut owned = BTreeMap::new();
        for index in 0..MAX_REMOTE_RECORDS {
            let coordinate = format!("{index:064x}");
            store_inbound_record(
                &mut store,
                &owned,
                valid_record(&coordinate, pointer('b', "wss://remote.example")),
            )
            .expect("remote cache has reserved capacity");
        }
        let rejected_coordinate = format!("{:064x}", MAX_REMOTE_RECORDS);
        assert!(store_inbound_record(
            &mut store,
            &owned,
            valid_record(&rejected_coordinate, pointer('b', "wss://remote.example")),
        )
        .is_err());

        for index in 0..MAX_OWNED_COORDINATES {
            let coordinate = format!("{:064x}", MAX_REMOTE_RECORDS + 1 + index);
            let local_pointer = pointer('c', "wss://owned.example");
            owned.insert(coordinate.clone(), vec![local_pointer.clone()]);
            let mut record = valid_record(&coordinate, local_pointer);
            record.publisher = Some(PeerId::random());
            store
                .put(record)
                .expect("remote cache cannot consume owned-record capacity");
        }
        assert_eq!(
            store.records().count(),
            MAX_REMOTE_RECORDS + MAX_OWNED_COORDINATES
        );
    }

    #[test]
    fn bootstrap_address_requires_peer_id_and_dial_address() {
        let peer = PeerId::random();
        let valid = format!("/ip4/127.0.0.1/tcp/4001/p2p/{peer}");
        let (parsed_peer, address) = parse_bootstrap_peer(&valid).expect("valid bootstrap");
        assert_eq!(parsed_peer, peer);
        assert_eq!(address.to_string(), "/ip4/127.0.0.1/tcp/4001");
        assert!(parse_bootstrap_peer("/ip4/127.0.0.1/tcp/4001").is_err());
    }

    fn temporary_test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "zine-kademlia-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[cfg(unix)]
    #[test]
    fn identity_is_created_private_and_rejects_unsafe_files() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let root = temporary_test_root("identity");
        fs::create_dir_all(&root).expect("test directory");
        let identity = root.join("identity.pb");
        let first = load_or_create_identity(&identity).expect("create identity safely");
        let metadata = fs::symlink_metadata(&identity).expect("identity metadata");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        let second = load_or_create_identity(&identity).expect("reload protected identity");
        assert_eq!(PeerId::from(first.public()), PeerId::from(second.public()));

        fs::set_permissions(&identity, fs::Permissions::from_mode(0o644))
            .expect("make identity unsafe for regression test");
        assert!(load_or_create_identity(&identity).is_err());
        fs::set_permissions(&identity, fs::Permissions::from_mode(0o600))
            .expect("restore private permissions");

        let link = root.join("identity-link.pb");
        symlink(&identity, &link).expect("create identity symlink");
        assert!(load_or_create_identity(&link).is_err());
        fs::remove_dir_all(root).expect("remove identity test directory");
    }

    #[test]
    fn pointer_persistence_applies_a_delta_without_losing_prior_coordinates() {
        let root = temporary_test_root("persistence");
        fs::create_dir_all(&root).expect("test directory");
        let path = root.join(OWNED_POINTERS_FILENAME);
        let other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        persist_owned_pointer(&path, H, pointer('c', "wss://first.example"))
            .expect("persist first coordinate");
        persist_owned_pointer(&path, other, pointer('d', "wss://second.example"))
            .expect("persist second coordinate");
        let loaded = load_owned_pointers(&path).expect("load persisted coordinates");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[H], vec![pointer('c', "wss://first.example")]);
        fs::remove_dir_all(root).expect("remove persistence test directory");
    }

    fn assert_invalid_pointer_file_is_not_overwritten(label: &str, bytes: Vec<u8>) {
        let root = temporary_test_root(label);
        fs::create_dir_all(&root).expect("test directory");
        let path = root.join(OWNED_POINTERS_FILENAME);
        fs::write(&path, &bytes).expect("write invalid pointer file");

        let error = persist_owned_pointer(&path, H, pointer('e', "wss://new.example"))
            .expect_err("invalid pointer file must block persistence");
        assert!(!error.is_empty());
        assert_eq!(
            fs::read(&path).expect("read preserved invalid pointer file"),
            bytes
        );
        fs::remove_dir_all(root).expect("remove invalid persistence test directory");
    }

    #[test]
    fn corrupt_owned_pointer_file_blocks_persistence_without_overwrite() {
        assert_invalid_pointer_file_is_not_overwritten(
            "corrupt-persistence",
            b"{not valid json".to_vec(),
        );
    }

    #[test]
    fn wrong_version_owned_pointer_file_blocks_persistence_without_overwrite() {
        let bytes = serde_json::to_vec(&OwnedPointerFile {
            version: 2,
            records: BTreeMap::new(),
        })
        .expect("serialize wrong-version pointer file");
        assert_invalid_pointer_file_is_not_overwritten("wrong-version-persistence", bytes);
    }

    #[test]
    fn oversized_owned_pointer_file_blocks_persistence_without_overwrite() {
        assert_invalid_pointer_file_is_not_overwritten(
            "oversized-persistence",
            vec![b' '; MAX_OWNED_POINTER_FILE_BYTES + 1],
        );
    }

    async fn wait_for_status(
        client: &KademliaClient,
        predicate: impl Fn(&KademliaStatus) -> bool,
    ) -> KademliaStatus {
        for _ in 0..100 {
            let status = client.status().await.expect("runtime status");
            if predicate(&status) {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("Kademlia runtime did not reach the expected state");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn runtime_start_waits_for_a_real_listener_and_rejects_an_occupied_port() {
        let occupied =
            std::net::TcpListener::bind("127.0.0.1:0").expect("reserve a local TCP port");
        let port = occupied.local_addr().expect("reserved address").port();
        let root = temporary_test_root("occupied-listener");
        let result = start_runtime(
            root.clone(),
            KademliaStartConfig {
                bootstrap_peers: Vec::new(),
                listen_address: Some(format!("/ip4/127.0.0.1/tcp/{port}")),
            },
        )
        .await;
        assert!(
            result.is_err(),
            "an asynchronously failed bind must reject start"
        );
        drop(occupied);
        fs::remove_dir_all(root).expect("remove occupied-listener test directory");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_real_node_can_publish_and_lookup_locally() {
        let root = temporary_test_root("one-node");
        let client = start_runtime(
            root.clone(),
            KademliaStartConfig {
                bootstrap_peers: Vec::new(),
                listen_address: Some("/ip4/127.0.0.1/tcp/0".to_string()),
            },
        )
        .await
        .expect("start standalone DHT node");
        wait_for_status(&client, |status| !status.listeners.is_empty()).await;

        let expected = pointer('b', "wss://relay.example");
        client
            .publish(H.to_string(), expected.clone())
            .await
            .expect("store a pointer on a standalone node");
        let found = client.lookup(H.to_string()).await.expect("local lookup");
        assert!(found.contains(&expected));

        client.stop().await;
        fs::remove_dir_all(root).expect("remove standalone test directory");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_real_nodes_publish_and_lookup_one_pointer() {
        let root = temporary_test_root("two-node");
        let first_dir = root.join("first");
        let second_dir = root.join("second");

        let first = start_runtime(
            first_dir,
            KademliaStartConfig {
                bootstrap_peers: Vec::new(),
                listen_address: Some("/ip4/127.0.0.1/tcp/0".to_string()),
            },
        )
        .await
        .expect("start first DHT node");
        let first_status = wait_for_status(&first, |status| !status.listeners.is_empty()).await;
        let bootstrap = format!("{}/p2p/{}", first_status.listeners[0], first_status.peer_id);

        let second = start_runtime(
            second_dir,
            KademliaStartConfig {
                bootstrap_peers: vec![bootstrap],
                listen_address: Some("/ip4/127.0.0.1/tcp/0".to_string()),
            },
        )
        .await
        .expect("start second DHT node");
        wait_for_status(&second, |status| status.connected_peers >= 1).await;

        let expected = pointer('b', "wss://relay.example");
        second
            .publish(H.to_string(), expected.clone())
            .await
            .expect("publish pointer to a real peer");
        let found = first.lookup(H.to_string()).await.expect("lookup pointer");
        assert!(found.contains(&expected));

        second.stop().await;
        first.stop().await;
        fs::remove_dir_all(root).expect("remove DHT test directory");
    }
}
