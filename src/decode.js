// `decodeURIComponent` throws a URIError on malformed percent-encoding such as
// "%" or "%zz". Those bytes reach us from anything we do not control — a cookie
// another system left on the domain, a hand-typed URL, a crawler — so a throw
// here would turn one bad byte into a 500 on every request that parses it.
// Falling back to the raw text keeps the caller's shape intact: a segment that
// stays percent-encoded simply matches nothing downstream.
export function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
