export const LONG_PASTE_LINE_THRESHOLD = 15;

export interface PasteDecision {
  text: string;
  lineCount: number;
  replacedWithPlaceholder: boolean;
  index?: number;
}

export class TurnPasteCounter {
  private nextIndex = 1;

  reset(): void {
    this.nextIndex = 1;
  }

  next(): number {
    const current = this.nextIndex;
    this.nextIndex += 1;
    return current;
  }
}

export function countTextLines(text: string): number {
  if (text.length === 0) return 1;
  return text.split("\n").length;
}

export function classifyPastedText(
  text: string,
  counter: TurnPasteCounter,
  threshold = LONG_PASTE_LINE_THRESHOLD,
): PasteDecision {
  const lineCount = countTextLines(text);
  if (lineCount <= threshold) {
    return {
      text,
      lineCount,
      replacedWithPlaceholder: false,
    };
  }

  const index = counter.next();
  return {
    text: `[Pasted Text #${index} - ${lineCount} lines]`,
    lineCount,
    replacedWithPlaceholder: true,
    index,
  };
}
