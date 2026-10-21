/** Anything the compiler refuses — a parse failure, an unknown function, a unit or
 * kind mismatch, a guard tripped. Always a message a spreadsheet author or a
 * publisher can act on, never a stack trace. */
export class FormulaCompileError extends Error {}
