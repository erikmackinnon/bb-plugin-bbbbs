import type { IDisposable, IFunctionIdentifier } from "@xterm/xterm";

type Parameters = (number | number[])[];
interface ReplyParser {
  registerCsiHandler(id: IFunctionIdentifier, handler: (params: Parameters) => boolean): IDisposable;
  registerDcsHandler(id: IFunctionIdentifier, handler: (data: string, params: Parameters) => boolean): IDisposable;
  registerOscHandler(id: number, handler: (data: string) => boolean): IDisposable;
}

/** The backend terminal answers live device queries. A browser only renders
 * output, including historical queries in replay. Intercept query commands
 * at the parser, so real keyboard input never needs an ambiguous byte filter.
 */
export function suppressBrowserTerminalReplies(terminal: { parser: ReplyParser }): IDisposable {
  const parser = terminal.parser;
  const handlers = [
    parser.registerCsiHandler({ final: "c" }, () => true),
    parser.registerCsiHandler({ prefix: ">", final: "c" }, () => true),
    parser.registerCsiHandler({ final: "n" }, () => true),
    parser.registerCsiHandler({ prefix: "?", final: "n" }, () => true),
    parser.registerCsiHandler({ intermediates: "$", final: "p" }, () => true),
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, () => true),
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => true),
    // Report-only window operations. False preserves title stack and other
    // window changes; xterm itself checks which operations are enabled.
    parser.registerCsiHandler({ final: "t" }, (params) => [14, 16, 18].includes(params[0] as number)),
    // OSC color setters use the same identifiers as color queries. Let
    // setting-only commands fall through to xterm's original handlers.
    parser.registerOscHandler(4, (data) => data.split(";").some((slot, index) => index % 2 === 1 && slot === "?")),
    ...[10, 11, 12].map((id) => parser.registerOscHandler(id, (data) => data.split(";").includes("?"))),
  ];
  return { dispose() { for (const handler of handlers.splice(0)) handler.dispose(); } };
}
