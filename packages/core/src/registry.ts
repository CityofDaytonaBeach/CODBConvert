/**
 * Converter registry. Individual packages (@codb/pdf, @codb/image, ...) plug
 * converter implementations into this registry. CODBDocs picks a backend,
 * then delegates to the registered implementation.
 */

import type { CapabilityReport, ExecutionBackend } from "./capabilities";
import type { CODBConvertOptions, CODBInput, CODBOutput, CODBOutputFormat } from "./types";

export interface ConversionContext {
  report: CapabilityReport;
  backend: ExecutionBackend;
  options: CODBConvertOptions;
  progress(message: string, percent: number): void;
}

export type ConverterFn = (
  input: CODBInput | CODBInput[],
  options: CODBConvertOptions,
  ctx: ConversionContext,
) => Promise<CODBOutput>;

export interface ConverterRegistration {
  /** Backends this converter supports. */
  backends: ExecutionBackend[];
  run: ConverterFn;
}

export interface ConverterKey {
  /** Normalized category: pdf, image, office, media, ocr, ... */
  category: string;
  /** Operation name. */
  op: string;
}

class ConverterRegistry {
  private map = new Map<string, ConverterRegistration[]>();

  register(key: ConverterKey, impl: ConverterRegistration): void {
    const k = this.hash(key);
    const list = this.map.get(k) ?? [];
    list.push(impl);
    this.map.set(k, list);
  }

  get(key: ConverterKey): ConverterRegistration[] {
    return this.map.get(this.hash(key)) ?? [];
  }

  private hash(key: ConverterKey): string {
    return `${key.category}:${key.op}`;
  }
}

/** Global registry shared across the CODB package family. */
export const registry = new ConverterRegistry();

export { ConverterRegistry };
