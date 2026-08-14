import { TextDecoder } from "node:util";

export interface OperatorInputStream extends AsyncIterable<Uint8Array | string> {
  readonly isTTY?: boolean;
}

export interface OperatorOutput {
  write(chunk: string): unknown;
}

const MAX_INPUT_BYTES = 4_096;

export async function readOperatorLines(
  input: OperatorInputStream,
  expectedLines: number,
): Promise<readonly string[]> {
  if (input.isTTY === true) throw new Error("Operator input must not be a TTY");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for await (const chunk of input) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_INPUT_BYTES) throw new Error("Operator input is too long");
      chunks.push(decoder.decode(buffer, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    if (error instanceof TypeError) throw new Error("Operator input is not valid UTF-8");
    throw error;
  }
  const text = chunks.join("");
  const hasFinalLineFeed = text.endsWith("\n");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== expectedLines) throw new Error("Operator input has an invalid line count");
  return lines.map((line, index) => {
    if (!hasFinalLineFeed && index === lines.length - 1) return line;
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  });
}

export function rejectCommandArguments(argv: readonly string[]): void {
  if (argv.length > 2) throw new Error("Operator commands do not accept positional arguments");
}

export function safeFailure(stderr: OperatorOutput): void {
  stderr.write("Operator command failed.\n");
}
