import { OAuth2Client } from "google-auth-library";
export declare function loadCredentials(): Promise<{
    installed?: object;
    web?: object;
}>;
export declare function getAuthClient(credentialsPath?: string): Promise<OAuth2Client>;
export declare function validateAuth(auth: OAuth2Client): Promise<boolean>;
//# sourceMappingURL=auth.d.ts.map