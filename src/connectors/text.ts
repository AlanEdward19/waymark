/** Normalise source line endings before markdown rendering and comparisons. */
export const lf = (text: string) => text.replace(/\r\n?/g, '\n');
