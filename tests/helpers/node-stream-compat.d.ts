import "node:stream/web";

// Happy DOM's declarations use the Node 24 name for this identical Node 22
// stream interface. Keep production typing on the supported Node 22 baseline.
declare module "node:stream/web" {
  interface UnderlyingDefaultSource<R = unknown> extends UnderlyingSource<R> {}
}
