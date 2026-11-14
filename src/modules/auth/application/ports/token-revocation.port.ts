export interface TokenRevocationStore {
  revoke(jti: string, expSeconds: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}
