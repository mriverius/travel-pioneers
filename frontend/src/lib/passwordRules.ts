/**
 * Password policy — keep the rules in sync with the backend validators in
 * `backend/src/routes/auth.ts`. Anything that's rejected on the server must
 * also be rejected here so the user isn't surprised by a 400 after submit.
 */

export interface PasswordRule {
  id: "length" | "lowercase" | "uppercase" | "digit" | "special";
  label: string;
  test: (password: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: "length",
    label: "Al menos 8 caracteres",
    test: (p) => p.length >= 8 && p.length <= 128,
  },
  {
    id: "lowercase",
    label: "Una letra minúscula (a-z)",
    test: (p) => /[a-z]/.test(p),
  },
  {
    id: "uppercase",
    label: "Una letra mayúscula (A-Z)",
    test: (p) => /[A-Z]/.test(p),
  },
  {
    id: "digit",
    label: "Un número (0-9)",
    test: (p) => /[0-9]/.test(p),
  },
  {
    id: "special",
    label: "Un carácter especial (!@#$…)",
    test: (p) => /[^A-Za-z0-9]/.test(p),
  },
];

export function evaluatePassword(password: string) {
  return PASSWORD_RULES.map((rule) => ({
    ...rule,
    passed: rule.test(password),
  }));
}

export function isPasswordValid(password: string): boolean {
  return PASSWORD_RULES.every((rule) => rule.test(password));
}
