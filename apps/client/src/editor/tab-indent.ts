import { indentUnit } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";

/** One Markdown indentation unit. Four columns can nest beneath both `- ` and
 * `1. ` list markers, unlike their marker-width-specific minimums. */
export const MARKDOWN_TAB_WIDTH = 4;

/** Keep inserted indentation and the display width of imported tab
 * characters on the same four-column grid. New edits always insert spaces. */
export const markdownIndentExtensions: readonly Extension[] = [
  EditorState.tabSize.of(MARKDOWN_TAB_WIDTH),
  indentUnit.of(" ".repeat(MARKDOWN_TAB_WIDTH)),
];
