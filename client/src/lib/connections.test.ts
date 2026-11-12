import { describe as group, expect, it } from "vitest";
import { describe, validate, type Connection } from "./connections";

const direct: Connection = { id: "a", name: "Build box", kind: "direct", host: "box.tailnet.ts.net", port: 8765 };
const ssh: Connection = { id: "b", name: "Lab", kind: "ssh", host: "lab", port: 8765, sshUser: "drew", sshPort: 2222 };

group("validate", () => {
  it("accepts a complete connection", () => {
    expect(validate(direct, "secret", true)).toEqual({});
    expect(validate(ssh, "", false)).toEqual({}); // A saved token is kept.
  });

  it("reports each bad field", () => {
    const errors = validate({ ...direct, name: " ", host: "-oProxyCommand=x", port: 70000 }, "", true);
    expect(Object.keys(errors).sort()).toEqual(["host", "name", "port", "token"]);
  });

  it("needs a password only for a password login", () => {
    expect(validate({ ...ssh, sshAuth: "password" }, "t", true, "")).toEqual({ sshPassword: "Enter the SSH password." });
    expect(validate({ ...ssh, sshAuth: "password" }, "t", true, "pw")).toEqual({});
    expect(validate({ ...ssh, sshAuth: "key" }, "t", true, "")).toEqual({}); // No key: the keys of this computer.
    expect(validate(ssh, "t", true)).toEqual({});
  });

  it("checks the SSH fields only for an SSH connection", () => {
    expect(validate({ ...ssh, sshUser: "a b", sshPort: 0 }, "t", true)).toEqual({
      sshUser: "The user cannot have spaces or start with -.",
      sshPort: "Enter a port from 1 to 65535.",
    });
    expect(validate({ ...direct, sshUser: "a b" }, "t", true)).toEqual({});
  });
});

group("describe", () => {
  it("shows the address of each kind", () => {
    expect(describe(direct)).toBe("box.tailnet.ts.net:8765");
    expect(describe(ssh)).toBe("SSH drew@lab:2222, daemon port 8765");
    expect(describe({ ...ssh, sshUser: undefined, sshPort: 22 })).toBe("SSH lab, daemon port 8765");
  });
});
