import { Buffer } from "node:buffer";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { COMMANDS } from "../commands.js";
import { TEXT, SYMBOLS } from "../theme.js";

const CLOSED_TEXT = "\u5df2\u5173\u95ed agent";
const BUSY_PLACEHOLDER = "agent \u6b63\u5728\u56de\u590d...";
const IDLE_PLACEHOLDER = "\u5728\u6b64\u8f93\u5165\u6d88\u606f\uff0c\u6216\u8f93\u5165 /help \u67e5\u770b\u547d\u4ee4";
const BUSY_HINT = "agent \u6b63\u5728\u54cd\u5e94\uff0c\u6309 Esc \u6253\u65ad\u751f\u6210\u3002";
const UNKNOWN_COMMAND_HINT = "\u672a\u77e5\u547d\u4ee4\uff0c\u8bd5\u8bd5 /help";
const PASTE_COMPACT_THRESHOLD_BYTES = 1024;
const PASTE_AGGREGATE_DELAY_MS = 24;
const MAX_INPUT_LINES = 8;
const BRACKETED_PASTE_START = "\x1B[200~";
const BRACKETED_PASTE_END = "\x1B[201~";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  busy: boolean;
  closed?: boolean;
  width?: number;
}

type InputSegment = {
  id: string;
  kind: "text" | "paste";
  text: string;
  groupId?: string;
};

type PendingInput = {
  text: string;
  cursorOffset: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export const Composer: React.FC<Props> = ({
  value,
  onChange,
  onSubmit,
  busy,
  closed = false,
  width,
}) => {
  const hint = useHint(value, busy, closed);
  const borderColor = closed ? "gray" : busy ? "yellow" : "cyan";
  const accentColor = closed ? "gray" : busy ? "yellow" : "cyan";
  const boxWidth = width ? Math.max(width, 20) : undefined;

  return (
    <Box flexDirection="column" width={boxWidth}>
      <Box width={boxWidth} minHeight={1}>
        <Text color={TEXT.muted} wrap="truncate-end">
          {hint}
        </Text>
      </Box>
      <Box width={boxWidth} borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text color={accentColor} bold>
          {SYMBOLS.prompt}{" "}
        </Text>
        <Box flexGrow={1}>
          <SingleLineInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            disabled={busy || closed}
            placeholder={closed ? CLOSED_TEXT : busy ? BUSY_PLACEHOLDER : IDLE_PLACEHOLDER}
            {...(boxWidth ? { width: Math.max(1, boxWidth - 6) } : {})}
          />
        </Box>
      </Box>
    </Box>
  );
};

function useHint(value: string, busy: boolean, closed: boolean): string {
  return useMemo(() => {
    if (closed) return CLOSED_TEXT;
    if (busy) return BUSY_HINT;

    if (value.startsWith("/")) {
      const head = value.split(" ")[0] ?? "/";
      const headName = head.startsWith("/") ? head.slice(1) : head;
      const match = COMMANDS.find((command) => command.name.startsWith(headName));
      if (!match) return UNKNOWN_COMMAND_HINT;
      return `/${match.name}${match.implemented ? "" : " (todo)"} - ${match.description}`;
    }

    return "";
  }, [value, busy, closed]);
}

interface SingleLineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  width?: number;
}

const SingleLineInput: React.FC<SingleLineInputProps> = ({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  width,
}) => {
  const [segments, setSegments] = useState<InputSegment[]>(() => valueToSegments(value));
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const segmentsRef = useRef(segments);
  const cursorOffsetRef = useRef(cursorOffset);
  const valueRef = useRef(value);
  const idCounterRef = useRef(0);
  const activePasteGroupRef = useRef<string | null>(null);
  const bracketedPasteRef = useRef<{ text: string; cursorOffset: number } | null>(null);
  const pendingInputRef = useRef<PendingInput | null>(null);

  useEffect(() => {
    if (!process.stdout.isTTY) return;

    process.stdout.write("\x1B[?2004h");
    return () => {
      process.stdout.write("\x1B[?2004l");
    };
  }, []);

  useEffect(() => {
    return () => {
      const pending = pendingInputRef.current;
      if (pending?.timer) clearTimeout(pending.timer);
    };
  }, []);

  useEffect(() => {
    const currentValue = segmentsToValue(segmentsRef.current);
    if (value === currentValue) {
      valueRef.current = value;
      return;
    }

    const nextSegments = valueToSegments(value);
    segmentsRef.current = nextSegments;
    valueRef.current = value;
    setSegments(nextSegments);
    setCursor(Math.min(cursorOffsetRef.current, value.length));
  }, [value]);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    cursorOffsetRef.current = cursorOffset;
  }, [cursorOffset]);

  useInput((input, key) => {
    if (disabled) return;
    if (key.upArrow || key.downArrow || key.tab || (key.ctrl && input === "c")) return;

    if (key.return) {
      flushPendingInput();
      onSubmit(valueRef.current);
      setCursor(0);
      return;
    }

    if (key.leftArrow) {
      flushPendingInput();
      setCursor(previousCursorOffset(segmentsRef.current, cursorOffsetRef.current));
      return;
    }

    if (key.rightArrow) {
      flushPendingInput();
      setCursor(nextCursorOffset(segmentsRef.current, cursorOffsetRef.current));
      return;
    }

    if (key.backspace || key.delete) {
      flushPendingInput();
      const deletion = deleteBeforeCursor(segmentsRef.current, cursorOffsetRef.current);
      if (!deletion) return;
      commitSegments(deletion.segments, deletion.cursorOffset);
      return;
    }

    handleRawInput(input);
  });

  if (!valueRef.current) {
    return (
      <Text>
        <Text inverse>{disabled ? " " : placeholder[0] ?? " "}</Text>
        <Text color={TEXT.muted}>{placeholder.slice(1)}</Text>
      </Text>
    );
  }

  const renderedLines = renderInputDisplay(segments, cursorOffset, width ?? 80);
  return (
    <Box flexDirection="column">
      {renderedLines.map((line, index) => (
        <Text key={index}>
          {line.before}
          <Text inverse>{line.cursor}</Text>
          {line.after}
        </Text>
      ))}
    </Box>
  );

  function commitSegments(nextSegments: InputSegment[], nextCursorOffset: number): void {
    const normalizedSegments = mergeAdjacentCompatibleSegments(nextSegments);
    const nextValue = segmentsToValue(normalizedSegments);
    segmentsRef.current = normalizedSegments;
    valueRef.current = nextValue;
    setSegments(normalizedSegments);
    onChange(nextValue);
    setCursor(nextCursorOffset);
  }

  function setCursor(nextCursor: number): void {
    const boundedCursor = Math.max(0, Math.min(valueRef.current.length, nextCursor));
    cursorOffsetRef.current = boundedCursor;
    setCursorOffset(boundedCursor);
  }

  function nextSegmentId(): string {
    idCounterRef.current += 1;
    return `input-${idCounterRef.current}`;
  }

  function currentPasteGroup(currentCursor: number): string {
    const segmentsSnapshot = segmentsRef.current;
    const previousSegment = segmentBeforeCursor(segmentsSnapshot, currentCursor);
    const canContinuePaste = previousSegment?.kind === "paste" && segmentEndOffset(segmentsSnapshot, previousSegment) === currentCursor;
    if (canContinuePaste && activePasteGroupRef.current) return activePasteGroupRef.current;

    const groupId = `paste-${nextSegmentId()}`;
    activePasteGroupRef.current = groupId;
    return groupId;
  }

  function handleRawInput(input: string): void {
    let remaining = input;
    while (remaining) {
      const activePaste = bracketedPasteRef.current;
      if (activePaste) {
        const endIndex = remaining.indexOf(BRACKETED_PASTE_END);
        if (endIndex < 0) {
          activePaste.text += remaining;
          return;
        }

        activePaste.text += remaining.slice(0, endIndex);
        flushBracketedPaste();
        remaining = remaining.slice(endIndex + BRACKETED_PASTE_END.length);
        continue;
      }

      const startIndex = remaining.indexOf(BRACKETED_PASTE_START);
      if (startIndex < 0) {
        enqueueInputText(remaining);
        return;
      }

      if (startIndex > 0) {
        enqueueInputText(remaining.slice(0, startIndex));
        flushPendingInput();
      }

      bracketedPasteRef.current = { text: "", cursorOffset: cursorOffsetRef.current };
      remaining = remaining.slice(startIndex + BRACKETED_PASTE_START.length);
    }
  }

  function enqueueInputText(input: string): void {
    const cleanInput = sanitizeComposerInput(input);
    if (!cleanInput) return;

    const existing = pendingInputRef.current;
    if (existing) {
      existing.text += cleanInput;
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(flushPendingInput, PASTE_AGGREGATE_DELAY_MS);
      return;
    }

    pendingInputRef.current = {
      text: cleanInput,
      cursorOffset: cursorOffsetRef.current,
      timer: setTimeout(flushPendingInput, PASTE_AGGREGATE_DELAY_MS),
    };
  }

  function flushPendingInput(): void {
    const pending = pendingInputRef.current;
    pendingInputRef.current = null;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    insertInputText(pending.text, isLikelyPastedInput(pending.text), pending.cursorOffset);
  }

  function flushBracketedPaste(): void {
    const paste = bracketedPasteRef.current;
    bracketedPasteRef.current = null;
    if (!paste) return;

    const cleanInput = sanitizeComposerInput(paste.text);
    if (!cleanInput) return;
    insertInputText(cleanInput, true, paste.cursorOffset);
  }

  function insertInputText(input: string, fromPaste: boolean, cursorOverride?: number): void {
    const cleanInput = fromPaste ? input : sanitizeComposerInput(input);
    if (!cleanInput) return;

    const cursor = cursorOverride ?? cursorOffsetRef.current;
    const kind: InputSegment["kind"] = shouldCompactPaste(cleanInput, fromPaste) ? "paste" : "text";
    const groupId = kind === "paste" ? currentPasteGroup(cursor) : undefined;
    if (kind === "text") activePasteGroupRef.current = null;
    const nextSegment: InputSegment = { id: nextSegmentId(), kind, text: cleanInput, ...(groupId ? { groupId } : {}) };
    const inserted = insertSegmentAtCursor(segmentsRef.current, cursor, nextSegment);
    commitSegments(inserted.segments, inserted.cursorOffset);
  }
};

export function sanitizeComposerInput(input: string): string {
  return input
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function shouldCompactPaste(input: string, fromPaste: boolean): boolean {
  return (fromPaste || isPasteInput(input)) && Buffer.byteLength(input, "utf8") > PASTE_COMPACT_THRESHOLD_BYTES;
}

function isPasteInput(input: string): boolean {
  return Buffer.byteLength(input, "utf8") > PASTE_COMPACT_THRESHOLD_BYTES;
}

function isLikelyPastedInput(input: string): boolean {
  return input.includes("\n") || Buffer.byteLength(input, "utf8") > PASTE_COMPACT_THRESHOLD_BYTES;
}

function valueToSegments(value: string): InputSegment[] {
  return value ? [{ id: "external-1", kind: "text", text: value }] : [];
}

function segmentsToValue(segments: InputSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

function insertSegmentAtCursor(
  segments: InputSegment[],
  cursorOffset: number,
  segment: InputSegment,
): { segments: InputSegment[]; cursorOffset: number } {
  const position = findSegmentPosition(segments, cursorOffset);
  if (position.index >= segments.length) {
    return { segments: [...segments, segment], cursorOffset: cursorOffset + segment.text.length };
  }

  const current = segments[position.index];
  if (!current) {
    return { segments: [segment], cursorOffset: segment.text.length };
  }

  if (current.kind === "paste") {
    const insertIndex = position.localOffset <= 0 ? position.index : position.index + 1;
    return {
      segments: [...segments.slice(0, insertIndex), segment, ...segments.slice(insertIndex)],
      cursorOffset: cursorOffset + segment.text.length,
    };
  }

  const before = current.text.slice(0, position.localOffset);
  const after = current.text.slice(position.localOffset);
  const replacement: InputSegment[] = [];
  if (before) replacement.push({ ...current, text: before });
  replacement.push(segment);
  if (after) replacement.push({ ...current, id: `${current.id}-tail`, text: after });

  return {
    segments: [...segments.slice(0, position.index), ...replacement, ...segments.slice(position.index + 1)],
    cursorOffset: cursorOffset + segment.text.length,
  };
}

function deleteBeforeCursor(
  segments: InputSegment[],
  cursorOffset: number,
): { segments: InputSegment[]; cursorOffset: number } | null {
  if (cursorOffset <= 0) return null;

  const position = findSegmentPosition(segments, cursorOffset);
  const targetIndex = position.index >= segments.length || position.localOffset === 0 ? position.index - 1 : position.index;
  const target = segments[targetIndex];
  if (!target) return null;

  const targetStart = segmentStartOffset(segments, targetIndex);
  if (target.kind === "paste") {
    return {
      segments: [...segments.slice(0, targetIndex), ...segments.slice(targetIndex + 1)],
      cursorOffset: targetStart,
    };
  }

  const localCursor = targetIndex === position.index ? position.localOffset : target.text.length;
  const previousOffset = previousStringOffset(target.text, localCursor);
  const nextText = target.text.slice(0, previousOffset) + target.text.slice(localCursor);
  const nextSegments = nextText
    ? [...segments.slice(0, targetIndex), { ...target, text: nextText }, ...segments.slice(targetIndex + 1)]
    : [...segments.slice(0, targetIndex), ...segments.slice(targetIndex + 1)];

  return { segments: nextSegments, cursorOffset: targetStart + previousOffset };
}

function previousCursorOffset(segments: InputSegment[], cursorOffset: number): number {
  if (cursorOffset <= 0) return 0;
  const position = findSegmentPosition(segments, cursorOffset);
  const targetIndex = position.index >= segments.length || position.localOffset === 0 ? position.index - 1 : position.index;
  const target = segments[targetIndex];
  if (!target) return 0;
  const targetStart = segmentStartOffset(segments, targetIndex);
  if (target.kind === "paste") return targetStart;
  const localCursor = targetIndex === position.index ? position.localOffset : target.text.length;
  return targetStart + previousStringOffset(target.text, localCursor);
}

function nextCursorOffset(segments: InputSegment[], cursorOffset: number): number {
  const totalLength = segmentsToValue(segments).length;
  if (cursorOffset >= totalLength) return totalLength;
  const position = findSegmentPosition(segments, cursorOffset);
  const target = segments[position.index];
  if (!target) return totalLength;
  const targetStart = segmentStartOffset(segments, position.index);
  if (target.kind === "paste") return targetStart + target.text.length;
  return targetStart + nextStringOffset(target.text, position.localOffset);
}

function findSegmentPosition(segments: InputSegment[], cursorOffset: number): { index: number; localOffset: number } {
  let remaining = Math.max(0, cursorOffset);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) break;
    if (remaining <= segment.text.length) {
      return { index, localOffset: remaining };
    }
    remaining -= segment.text.length;
  }
  return { index: segments.length, localOffset: 0 };
}

function segmentStartOffset(segments: InputSegment[], targetIndex: number): number {
  return segments.slice(0, Math.max(0, targetIndex)).reduce((total, segment) => total + segment.text.length, 0);
}

function segmentBeforeCursor(segments: InputSegment[], cursorOffset: number): InputSegment | undefined {
  if (cursorOffset <= 0) return undefined;
  const position = findSegmentPosition(segments, cursorOffset);
  const targetIndex = position.index >= segments.length || position.localOffset === 0 ? position.index - 1 : position.index;
  return segments[targetIndex];
}

function segmentEndOffset(segments: InputSegment[], target: InputSegment): number {
  const targetIndex = segments.findIndex((segment) => segment.id === target.id);
  if (targetIndex < 0) return -1;
  return segmentStartOffset(segments, targetIndex) + target.text.length;
}

function mergeAdjacentCompatibleSegments(segments: InputSegment[]): InputSegment[] {
  const merged: InputSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous.kind === "text" && segment.kind === "text") {
      previous.text += segment.text;
      continue;
    }
    if (previous && previous.kind === "paste" && segment.kind === "paste" && previous.groupId && previous.groupId === segment.groupId) {
      previous.text += segment.text;
      continue;
    }
    if (segment.text) merged.push({ ...segment });
  }
  return merged;
}

function renderInputDisplay(
  segments: InputSegment[],
  cursorOffset: number,
  width: number,
): Array<{ before: string; cursor: string; after: string }> {
  const maxWidth = Math.max(1, width);
  const renderState = buildRenderedText(segments, cursorOffset);
  const chars = Array.from(renderState.text);
  const cursorIndex = Math.max(0, Math.min(chars.length, renderState.cursorIndex));
  const lines = wrapCharsByDisplayWidth(chars, maxWidth);
  const cursorLineIndex = findCursorLineIndex(lines, cursorIndex);
  const firstVisibleLine = Math.max(0, cursorLineIndex - MAX_INPUT_LINES + 1);
  const visibleLines = lines.slice(firstVisibleLine, firstVisibleLine + MAX_INPUT_LINES);

  return visibleLines.map((line, index) => {
    const absoluteLineIndex = firstVisibleLine + index;
    const isCursorLine = absoluteLineIndex === cursorLineIndex;
    if (!isCursorLine) return { before: line.chars.join(""), cursor: "", after: "" };

    const localCursor = Math.max(0, Math.min(line.chars.length, cursorIndex - line.startIndex));
    return {
      before: line.chars.slice(0, localCursor).join(""),
      cursor: line.chars[localCursor] ?? " ",
      after: line.chars.slice(localCursor + 1).join(""),
    };
  });
}

type DisplayLine = {
  chars: string[];
  startIndex: number;
};

function wrapCharsByDisplayWidth(chars: string[], width: number): DisplayLine[] {
  if (chars.length === 0) return [{ chars: [], startIndex: 0 }];

  const lines: DisplayLine[] = [];
  let current: string[] = [];
  let currentWidth = 0;
  let currentStart = 0;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? "";
    const charWidth = displayWidth(char);
    if (current.length > 0 && currentWidth + charWidth > width) {
      lines.push({ chars: current, startIndex: currentStart });
      current = [];
      currentWidth = 0;
      currentStart = index;
    }

    current.push(char);
    currentWidth += charWidth;
  }

  lines.push({ chars: current, startIndex: currentStart });
  return lines;
}

function findCursorLineIndex(lines: DisplayLine[], cursorIndex: number): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const lineEnd = line.startIndex + line.chars.length;
    const isLastLine = index === lines.length - 1;
    if (cursorIndex >= line.startIndex && (cursorIndex < lineEnd || isLastLine)) return index;
  }
  return Math.max(0, lines.length - 1);
}

function displayWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0) return 0;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

function buildRenderedText(segments: InputSegment[], cursorOffset: number): { text: string; cursorIndex: number } {
  let sourceOffset = 0;
  let rendered = "";
  let cursorIndex: number | null = null;

  for (const segment of segments) {
    const segmentStart = sourceOffset;
    const segmentEnd = segmentStart + segment.text.length;
    const displayText = segment.kind === "paste" ? pasteSummary(segment.text) : segment.text.replace(/\n/g, "\\n");
    const displayChars = Array.from(displayText);

    if (cursorIndex === null && cursorOffset >= segmentStart && cursorOffset <= segmentEnd) {
      if (segment.kind === "paste") {
        cursorIndex = rendered.length + (cursorOffset <= segmentStart ? 0 : displayChars.length);
      } else {
        const localCursor = cursorOffset - segmentStart;
        cursorIndex = Array.from(rendered + displayText.slice(0, localCursor)).length;
      }
    }

    rendered += displayText;
    sourceOffset = segmentEnd;
  }

  return { text: rendered, cursorIndex: cursorIndex ?? Array.from(rendered).length };
}

function pasteSummary(value: string): string {
  return `[\u7c98\u8d34:${Buffer.byteLength(value, "utf8")}\u5b57\u8282]`;
}

function previousStringOffset(value: string, offset: number): number {
  const prefix = value.slice(0, Math.max(0, offset));
  const chars = Array.from(prefix);
  chars.pop();
  return chars.join("").length;
}

function nextStringOffset(value: string, offset: number): number {
  const suffix = value.slice(Math.max(0, offset));
  const [nextChar] = Array.from(suffix);
  return Math.min(value.length, offset + (nextChar?.length ?? 0));
}
