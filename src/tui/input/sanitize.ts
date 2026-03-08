const ANSI_PATTERN =
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const CONTROL_PATTERN = /[\x00-\x08\x0B-\x1F\x7F]/g;

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function stripAnsiSequences(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function stripUnsafeControls(text: string): string {
  return text.replace(CONTROL_PATTERN, "");
}

export function sanitizeInputText(text: string): string {
  return stripUnsafeControls(stripAnsiSequences(normalizeLineEndings(text)));
}

export function sanitizeSubmitText(text: string): string {
  // Submit sanitization intentionally mirrors input sanitization so we
  // never send control sequences even if they got into state somehow.
  return sanitizeInputText(text);
}

