/** A language's texts for an area: every key of the Chinese area, no others. */
export type Messages<T> = { [K in keyof T]: string };
