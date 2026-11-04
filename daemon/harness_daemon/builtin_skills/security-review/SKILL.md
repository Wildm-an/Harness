---
name: security-review
description: "Review the pending code changes for security vulnerabilities: injection, broken access control, secrets in code, unsafe input handling, path traversal, SSRF, XSS, and unsafe crypto. Use for /security-review or \"is this change secure\". It reports only findings that an attacker can exploit."
argument-hint: "[branch | commit | PR number | path]"
---

# Review changes for security vulnerabilities

Arguments: $ARGUMENTS

Find vulnerabilities that the change adds and that an attacker can use. Report only findings with a clear attack path. False alarms make people ignore the review.

## 1. Get the changes

With no arguments, review the changes of the current branch: the uncommitted changes (`git diff HEAD`) and the commits that are not on the main branch (`git diff <main branch>...HEAD`). With an argument, use the same targets as the `code-review` skill: a branch, a commit, a pull request number (`gh pr diff <number>`), or a path.

## 2. Understand the context

1. Find what the code is: a web service, a command-line tool, a library, a desktop app.
2. Find the trust boundaries: where data comes from users, the network, files, environment variables, or other services.
3. Find the existing security controls: authentication, authorization checks, input validation, escaping helpers, query builders. A change that skips a control that the project uses elsewhere is a strong signal.

## 3. Check these categories

| Category | What to look for |
|---|---|
| Injection | User data in SQL, shell commands, `eval`, templates, LDAP, XPath, or NoSQL queries without parameters or escaping. |
| Access control | A new endpoint or action with no authentication or authorization check. An ID from the user that gives access to another user's data. |
| Secrets | Keys, tokens, passwords, or private URLs in code, config, logs, or error messages. |
| Path traversal | A file path built from user data without a check that it stays in the allowed folder. |
| SSRF | A request to a URL that the user controls, from a server that can reach internal services. |
| XSS | User data in HTML without escaping, `innerHTML`, `dangerouslySetInnerHTML`, or a disabled template escape. |
| Deserialization | `pickle`, `yaml.load` without a safe loader, Java or .NET deserialization of user data. |
| Crypto | A weak algorithm (MD5, SHA-1 for passwords, DES, ECB mode), a hard-coded key or IV, `random` instead of a secure random source, a disabled TLS check. |
| Session and CSRF | A state change through GET, a missing CSRF token, an insecure cookie flag, a token that does not expire. |
| Dependencies | A new package with a known vulnerability, or a package with a name close to a popular package. |

## 4. Verify each finding

For each possible finding:

1. Trace the data from its source (the attacker input) to the dangerous operation (the sink).
2. Check every step between them for validation, escaping, or a type that blocks the attack.
3. Write the attack: the input that the attacker sends and the result.
4. Give a confidence: high (the path is clear and nothing blocks it) or medium (one assumption is not proven). Do not report low-confidence findings.

Do not report these, unless the user asks:

- Denial of service and rate limits.
- Theoretical problems with no attack path in this code.
- Problems in test files, examples, or code that the change does not touch.
- Missing hardening that is not a vulnerability (for example, a missing security header on an internal tool).

## 5. Report

```
1. [High] <file>:<line> - <category>: <one sentence: the vulnerability>
   Attack: <the input> -> <the result for the attacker>
   Fix: <a short suggestion>
```

Sort by severity (critical, high, medium). End with one line: "N vulnerabilities found" or "No vulnerabilities found in the reviewed changes". Do not change files, unless the user asks for fixes.
