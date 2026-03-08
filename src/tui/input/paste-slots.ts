const PASTE_MARKER_START = 0xe000;
const PASTE_MARKER_END = 0xf8ff;

export interface PasteSlot {
  marker: string;
  label: string;
  text: string;
  lineCount: number;
  index: number;
}

export class TurnPasteSlotStore {
  private nextMarkerCode = PASTE_MARKER_START;
  private readonly slots = new Map<string, PasteSlot>();

  reset(): void {
    this.nextMarkerCode = PASTE_MARKER_START;
    this.slots.clear();
  }

  create(text: string, index: number, lineCount: number): string | null {
    if (this.nextMarkerCode > PASTE_MARKER_END) return null;

    const marker = String.fromCharCode(this.nextMarkerCode);
    this.nextMarkerCode += 1;

    this.slots.set(marker, {
      marker,
      label: `[Pasted Text #${index} - ${lineCount} lines]`,
      text,
      lineCount,
      index,
    });
    return marker;
  }

  labelFor(ch: string): string | undefined {
    return this.slots.get(ch)?.label;
  }

  expand(text: string): string {
    let result = "";
    for (const ch of text) {
      result += this.slots.get(ch)?.text ?? ch;
    }
    return result;
  }

  prune(text: string): void {
    const liveMarkers = new Set<string>();
    for (const ch of text) {
      if (this.slots.has(ch)) liveMarkers.add(ch);
    }
    for (const marker of this.slots.keys()) {
      if (!liveMarkers.has(marker)) this.slots.delete(marker);
    }
  }
}
