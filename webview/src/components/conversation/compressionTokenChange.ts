/** Token figures of one stored compression, as the card reads them. */
export interface CompressionTokenFigures {
  /** Context before the compression, in the same local estimate as `estimatedTokensAfter`. */
  contextTokensBefore?: number;
  estimatedTokensAfter?: number;
  /** The after-figure left an OpenAI ciphertext summary out (older records, or no usage returned). */
  resultSizeUncounted?: boolean;
}

/**
 * How much Context one compression saved: Context against Context in one estimate, negative when it
 * grew. Records that cannot tell have no saving instead of a wrong one: older automatic records only
 * kept the full request (system prompt and tool definitions included, which compression never
 * removes), and a ciphertext summary counted as 0 made the saving look larger than it was.
 */
export function compressionTokenChange(figures: CompressionTokenFigures): number | undefined {
  if (figures.resultSizeUncounted === true) return undefined;
  const { contextTokensBefore: before, estimatedTokensAfter: after } = figures;
  return before !== undefined && after !== undefined ? before - after : undefined;
}
