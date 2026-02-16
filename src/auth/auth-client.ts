/** Re-declare types locally to avoid importing server-side code into browser bundle */
export interface AuthUser {
  userId: string;
  teamId: string;
  email: string;
  role: "admin" | "member";
  displayName?: string;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    role: "admin" | "member";
    teamId: string;
    teamName: string;
  };
}

export class AuthClient {
  private _token: string | null = null;
  private _user: AuthUser | null = null;
  private listeners = new Set<(user: AuthUser | null) => void>();

  constructor() {
    // Restore from localStorage
    this._token = localStorage.getItem("chatbot_token");
    const userJson = localStorage.getItem("chatbot_user");
    if (userJson) {
      try { this._user = JSON.parse(userJson); } catch { this.clearStorage(); }
    }
  }

  get token() { return this._token; }
  get user() { return this._user; }
  get isAuthenticated() { return !!this._token && !!this._user; }

  /** Validate stored token by calling GET /api/auth/me */
  async validate(): Promise<boolean> {
    if (!this._token) return false;
    try {
      const res = await fetch("/api/auth/me", { headers: this.getHeaders() });
      if (!res.ok) { this.clearStorage(); return false; }
      return true;
    } catch {
      return false; // Network error, keep token (might be offline)
    }
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Login failed");
    this.setAuth(body.data);
    return body.data;
  }

  async register(email: string, password: string, displayName?: string, teamName?: string): Promise<AuthResponse> {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName, teamName }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Registration failed");
    this.setAuth(body.data);
    return body.data;
  }

  logout(): void {
    this.clearStorage();
    this.notify();
  }

  getHeaders(): Record<string, string> {
    if (!this._token) return {};
    return { Authorization: `Bearer ${this._token}` };
  }

  onAuthChange(callback: (user: AuthUser | null) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private setAuth(data: AuthResponse): void {
    this._token = data.token;
    this._user = {
      userId: data.user.id,
      teamId: data.user.teamId,
      email: data.user.email,
      role: data.user.role,
      displayName: data.user.displayName || undefined,
    };
    localStorage.setItem("chatbot_token", this._token);
    localStorage.setItem("chatbot_user", JSON.stringify(this._user));
    this.notify();
  }

  private clearStorage(): void {
    this._token = null;
    this._user = null;
    localStorage.removeItem("chatbot_token");
    localStorage.removeItem("chatbot_user");
  }

  private notify(): void {
    for (const cb of this.listeners) cb(this._user);
  }
}
