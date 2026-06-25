declare module "ff3/lib/FF3Cipher" {
  export default class FF3Cipher {
    constructor(key: string, tweak: string, radix?: number);
    encrypt(plaintext: string): string;
    decrypt(ciphertext: string): string;
  }
}
