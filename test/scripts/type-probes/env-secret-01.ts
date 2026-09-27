// @probe-name "wrong secret-storage usage fails compilation"
// @probe-codes [2322,2339,2345,2554,2554]
// @probe-origin test/scripts/envSecretTypeProbe.test.js
import { EnvironmentManager } from "./src/helpers/environment.ts";
import { encrypt, decrypt, isAvailable } from "./src/helpers/secretCrypto.ts";
import { BYOK_API_KEYS } from "./src/config/secretKeys.ts";

// Encryption takes a string, not a buffer.
encrypt(Buffer.from("not plaintext"));

// Decryption returns { value, needsReencrypt }, not a bare string.
const value: string = decrypt(Buffer.from("blob"));

// isAvailable is a boolean probe without arguments.
isAvailable("please");

// The manager constructor takes no options object.
new EnvironmentManager({ persistent: true });

// Manifest entries carry the catalog fields — accessing a fantasy field
// must fail instead of resolving through a string index.
for (const entry of BYOK_API_KEYS) {
  const fantasy: string = entry.notInTheCatalog;
  void fantasy;
}
void value;
