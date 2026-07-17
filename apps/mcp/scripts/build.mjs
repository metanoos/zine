import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  alias: {
    "@zine/protocol": join(
      packageRoot,
      "..",
      "..",
      "packages",
      "protocol",
      "src",
      "index.ts",
    ),
  },
  entryPoints: [join(packageRoot, "src", "server.ts")],
  bundle: true,
  format: "esm",
  minify: true,
  nodePaths: [join(packageRoot, "node_modules")],
  outfile: join(packageRoot, "dist", "server.js"),
  platform: "node",
});
