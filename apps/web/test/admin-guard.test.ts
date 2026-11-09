import { describe, expect, it } from "vitest";
import { adminRedirect } from "../lib/admin-guard";

describe("adminRedirect (§7.1: login + MFA obrigatório)", () => {
  it("sem sessão: só login e callback ficam abertos", () => {
    expect(adminRedirect({ path: "/admin", loggedIn: false, aal: null })).toBe("/admin/login");
    expect(adminRedirect({ path: "/admin/stories/x", loggedIn: false, aal: null })).toBe("/admin/login");
    expect(adminRedirect({ path: "/admin/mfa", loggedIn: false, aal: null })).toBe("/admin/login");
    expect(adminRedirect({ path: "/admin/login", loggedIn: false, aal: null })).toBeNull();
    expect(adminRedirect({ path: "/admin/auth/callback", loggedIn: false, aal: null })).toBeNull();
  });
  it("logado sem segundo fator (inclusive sem fator cadastrado): sempre para o MFA", () => {
    expect(adminRedirect({ path: "/admin", loggedIn: true, aal: "aal1" })).toBe("/admin/mfa");
    expect(adminRedirect({ path: "/admin/stories/x", loggedIn: true, aal: "aal1" })).toBe("/admin/mfa");
    expect(adminRedirect({ path: "/admin/mfa", loggedIn: true, aal: "aal1" })).toBeNull();
    expect(adminRedirect({ path: "/admin/logout", loggedIn: true, aal: "aal1" })).toBeNull();
  });
  it("com MFA: acesso liberado; login e MFA voltam para a fila", () => {
    expect(adminRedirect({ path: "/admin", loggedIn: true, aal: "aal2" })).toBeNull();
    expect(adminRedirect({ path: "/admin/stories/x", loggedIn: true, aal: "aal2" })).toBeNull();
    expect(adminRedirect({ path: "/admin/login", loggedIn: true, aal: "aal2" })).toBe("/admin");
    expect(adminRedirect({ path: "/admin/mfa", loggedIn: true, aal: "aal2" })).toBe("/admin");
  });
  it("prefixo parecido não vira rota pública", () => {
    expect(adminRedirect({ path: "/admin/login-falso", loggedIn: false, aal: null })).toBe("/admin/login");
  });
});
