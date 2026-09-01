import { clearCodeVerifier, getCodeVerifier, isProduction } from '@/components/shared';
// Import the hardcoded constants from your config utility
import { CLIENT_ID, REDIRECT_URI } from '@/components/shared/utils/config/config';
import { ErrorLogger } from '@/utils/error-logger';
import brandConfig from '../../brand.config.json';

/**
 * Response from OAuth2 token exchange endpoint
 */
interface TokenExchangeResponse {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
}

/**
 * Authentication information stored in sessionStorage
 */
interface AuthInfo {
    access_token: string;
    token_type: string;
    expires_in: number;
    expires_at: number;
    scope?: string;
    refresh_token?: string;
}

export class OAuthTokenExchangeService {
    /**
     * Pulls the Auth URL directly from brandConfig
     */
    private static getOAuth2BaseURL(): string {
        // We use 'production' because you hardcoded the environment to production
        const environment = 'production';
        return brandConfig.platform.auth2_url[environment];
    }

    static getAuthInfo(): AuthInfo | null {
        try {
            const authInfoStr = sessionStorage.getItem('auth_info');
            if (!authInfoStr) return null;

            const authInfo: AuthInfo = JSON.parse(authInfoStr);

            if (authInfo.expires_at && Date.now() >= authInfo.expires_at) {
                this.clearAuthInfo();
                return null;
            }

            return authInfo;
        } catch (error) {
            ErrorLogger.error('OAuth', 'Error parsing auth_info', error);
            return null;
        }
    }

    static clearAuthInfo(): void {
        sessionStorage.removeItem('auth_info');
    }

    static isAuthenticated(): boolean {
        const authInfo = this.getAuthInfo();
        return authInfo !== null && !!authInfo.access_token;
    }

    static getAccessToken(): string | null {
        const authInfo = this.getAuthInfo();
        return authInfo?.access_token || null;
    }

    /**
     * Updated: Now uses hardcoded CLIENT_ID and REDIRECT_URI
     */
    static async exchangeCodeForToken(code: string): Promise<TokenExchangeResponse> {
        try {
            const baseURL = this.getOAuth2BaseURL();
            const tokenEndpoint = baseURL.endsWith('/') ? `${baseURL}token` : `${baseURL}/token`;

            const codeVerifier = getCodeVerifier();

            if (!codeVerifier) {
                ErrorLogger.error('OAuth', 'PKCE code verifier not found or expired');
                return {
                    error: 'invalid_request',
                    error_description: 'PKCE code verifier not found or expired.',
                };
            }

            // CRITICAL FIX: Use the imported constant, not process.env
            const clientId = CLIENT_ID;

            // CRITICAL FIX: Use the hardcoded production redirect URI
            const redirectUrl = REDIRECT_URI;

            const requestBody = new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                client_id: clientId,
                redirect_uri: redirectUrl,
                code_verifier: codeVerifier,
            });

            const response = await fetch(tokenEndpoint, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: requestBody.toString(),
            });

            const data: TokenExchangeResponse = await response.json();

            if (data.error) {
                ErrorLogger.error('OAuth', `Token exchange error: ${data.error}`, {
                    error: data.error,
                    description: data.error_description,
                });
                return data;
            }

            if (data.access_token) {
                clearCodeVerifier();
                const authInfo: AuthInfo = {
                    access_token: data.access_token,
                    token_type: data.token_type || 'bearer',
                    expires_in: data.expires_in || 3600,
                    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
                    scope: data.scope,
                };

                if (data.refresh_token) {
                    authInfo.refresh_token = data.refresh_token;
                }

                sessionStorage.setItem('auth_info', JSON.stringify(authInfo));

                // Initialize WebSocket services...
                try {
                    const { DerivWSAccountsService } = await import('./derivws-accounts.service');
                    const accounts = await DerivWSAccountsService.fetchAccountsList(data.access_token);

                    if (accounts && accounts.length > 0) {
                        DerivWSAccountsService.storeAccounts(accounts);
                        const firstAccount = accounts[0];
                        localStorage.setItem('active_loginid', firstAccount.account_id);

                        const isDemo = firstAccount.account_id.startsWith('VRT');
                        localStorage.setItem('account_type', isDemo ? 'demo' : 'real');

                        const { api_base } = await import('@/external/bot-skeleton');
                        await api_base.init(true);
                    }
                } catch (error) {
                    ErrorLogger.error('OAuth', 'Error fetching accounts after exchange', error);
                }
            }

            return data;
        } catch (error: unknown) {
            ErrorLogger.error('OAuth', 'Token exchange network or parsing error', error);
            return {
                error: 'network_error',
                error_description: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    static async refreshAccessToken(refreshToken: string): Promise<TokenExchangeResponse> {
        try {
            const baseURL = this.getOAuth2BaseURL();
            const tokenEndpoint = baseURL.endsWith('/') ? `${baseURL}token` : `${baseURL}/token`;

            const requestBody = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: CLIENT_ID, // Also required for some refresh flows
            });

            const response = await fetch(tokenEndpoint, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: requestBody.toString(),
            });

            const data: TokenExchangeResponse = await response.json();

            if (data.access_token) {
                const existingAuth = this.getAuthInfo();
                const authInfo: AuthInfo = {
                    access_token: data.access_token,
                    token_type: data.token_type || 'bearer',
                    expires_in: data.expires_in || 3600,
                    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
                    scope: data.scope,
                    refresh_token: data.refresh_token || existingAuth?.refresh_token,
                };
                sessionStorage.setItem('auth_info', JSON.stringify(authInfo));
            }

            return data;
        } catch (error: unknown) {
            return { error: 'network_error' };
        }
    }
}
