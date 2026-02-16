import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AuthClient } from "./auth-client.js";

@customElement("login-page")
export class LoginPage extends LitElement {
  @property({ attribute: false })
  authClient!: AuthClient;

  @state() private mode: "login" | "register" = "login";
  @state() private email = "";
  @state() private password = "";
  @state() private displayName = "";
  @state() private teamName = "";
  @state() private error = "";
  @state() private loading = false;

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100vh;
      background: var(--background, #f9fafb);
      color: var(--foreground, #111827);
      font-family: system-ui, -apple-system, sans-serif;
    }

    .card {
      width: 100%;
      max-width: 400px;
      padding: 2rem;
      border-radius: 0.75rem;
      border: 1px solid var(--border, #e5e7eb);
      background: var(--card, #ffffff);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    h1 {
      margin: 0 0 0.25rem;
      font-size: 1.5rem;
      font-weight: 600;
      text-align: center;
    }

    .subtitle {
      margin: 0 0 1.5rem;
      font-size: 0.875rem;
      color: var(--muted-foreground, #6b7280);
      text-align: center;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    label {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
      font-size: 0.875rem;
      font-weight: 500;
    }

    input {
      padding: 0.5rem 0.75rem;
      border-radius: 0.375rem;
      border: 1px solid var(--border, #e5e7eb);
      background: var(--input, #ffffff);
      color: var(--foreground, #111827);
      font-size: 0.875rem;
      outline: none;
      transition: border-color 0.15s;
    }

    input:focus {
      border-color: var(--ring, #3b82f6);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
    }

    input::placeholder {
      color: var(--muted-foreground, #9ca3af);
    }

    .error {
      padding: 0.625rem 0.75rem;
      border-radius: 0.375rem;
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #dc2626;
      font-size: 0.8125rem;
      line-height: 1.4;
    }

    button[type="submit"] {
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      border: none;
      background: var(--primary, #111827);
      color: var(--primary-foreground, #ffffff);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }

    button[type="submit"]:hover:not(:disabled) {
      opacity: 0.9;
    }

    button[type="submit"]:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .toggle {
      margin-top: 1rem;
      text-align: center;
      font-size: 0.8125rem;
      color: var(--muted-foreground, #6b7280);
    }

    .toggle a {
      color: var(--primary, #3b82f6);
      text-decoration: none;
      cursor: pointer;
      font-weight: 500;
    }

    .toggle a:hover {
      text-decoration: underline;
    }
  `;

  private async handleSubmit(e: Event) {
    e.preventDefault();
    this.error = "";
    this.loading = true;

    try {
      if (this.mode === "login") {
        await this.authClient.login(this.email, this.password);
      } else {
        await this.authClient.register(
          this.email,
          this.password,
          this.displayName || undefined,
          this.teamName || undefined,
        );
      }
      this.dispatchEvent(new CustomEvent("auth-success", { bubbles: true, composed: true }));
    } catch (err: any) {
      this.error = err.message || "An unexpected error occurred";
    } finally {
      this.loading = false;
    }
  }

  private switchMode() {
    this.mode = this.mode === "login" ? "register" : "login";
    this.error = "";
  }

  render() {
    const isLogin = this.mode === "login";

    return html`
      <div class="card">
        <h1>${isLogin ? "Welcome back" : "Create an account"}</h1>
        <p class="subtitle">
          ${isLogin ? "Sign in to continue" : "Get started with your team"}
        </p>

        ${this.error ? html`<div class="error">${this.error}</div>` : ""}

        <form @submit=${this.handleSubmit}>
          <label>
            Email
            <input
              type="email"
              placeholder="you@example.com"
              .value=${this.email}
              @input=${(e: InputEvent) => this.email = (e.target as HTMLInputElement).value}
              required
              autocomplete="email"
            />
          </label>

          <label>
            Password
            <input
              type="password"
              placeholder=${isLogin ? "Enter your password" : "Choose a password"}
              .value=${this.password}
              @input=${(e: InputEvent) => this.password = (e.target as HTMLInputElement).value}
              required
              minlength="6"
              autocomplete=${isLogin ? "current-password" : "new-password"}
            />
          </label>

          ${!isLogin
            ? html`
                <label>
                  Display name
                  <input
                    type="text"
                    placeholder="Your name (optional)"
                    .value=${this.displayName}
                    @input=${(e: InputEvent) => this.displayName = (e.target as HTMLInputElement).value}
                    autocomplete="name"
                  />
                </label>

                <label>
                  Team name
                  <input
                    type="text"
                    placeholder="Your team (optional)"
                    .value=${this.teamName}
                    @input=${(e: InputEvent) => this.teamName = (e.target as HTMLInputElement).value}
                  />
                </label>
              `
            : ""}

          <button type="submit" ?disabled=${this.loading}>
            ${this.loading
              ? (isLogin ? "Signing in..." : "Creating account...")
              : (isLogin ? "Sign in" : "Create account")}
          </button>
        </form>

        <div class="toggle">
          ${isLogin
            ? html`Don't have an account? <a @click=${this.switchMode}>Sign up</a>`
            : html`Already have an account? <a @click=${this.switchMode}>Sign in</a>`}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "login-page": LoginPage;
  }
}
