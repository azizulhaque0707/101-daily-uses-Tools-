/**
 * Minimal types for mammoth's browser bundle.
 *
 * mammoth ships an untyped CommonJS browser build, so the small surface the
 * document tools use is declared here.
 */
declare module "mammoth/mammoth.browser" {
  export interface MammothMessage {
    type: string;
    message: string;
  }

  export interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }

  export interface MammothInput {
    arrayBuffer: ArrayBuffer;
  }

  const mammoth: {
    convertToHtml(input: MammothInput, options?: Record<string, unknown>): Promise<MammothResult>;
    extractRawText(input: MammothInput): Promise<MammothResult>;
  };

  export default mammoth;
}
