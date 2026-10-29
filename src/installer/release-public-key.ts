// Ed25519 public key for release manifest signatures.
// The matching private key is stored outside the repository and must never be
// committed. Rotate both keys together when this value changes.
export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXXtE7c38XeK4YstHO5X/UhiWb3zIe0mer7BxCK1Zmc8=
-----END PUBLIC KEY-----
`;
