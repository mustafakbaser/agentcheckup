# Security Policy

agentcheckup reads files from repositories you may not control. We treat every
scanned file as untrusted input, and we treat security reports as our highest
priority.

## Supported versions

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest `0.x` minor | Yes                |
| Older `0.x` minors | No, please upgrade |

Once `1.0.0` ships, the latest major and the previous major receive security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/mustafakbaser/agentcheckup/security/advisories/new).

If that is unavailable, email **info@mustafabaser.net** with the subject line
`[agentcheckup security]`.

Please include:

- The agentcheckup version (`npx agentcheckup --version`) and your Node.js version
- A minimal reproduction, ideally a small repository or file
- The impact you observed and the impact you believe is possible

## What to expect

| Step                                       | Target                 |
| ------------------------------------------ | ---------------------- |
| Acknowledgement                            | within 3 business days |
| Initial assessment                         | within 7 days          |
| Fix or mitigation for high/critical issues | within 30 days         |

We coordinate disclosure with you, credit you in the advisory unless you prefer
otherwise, and request a CVE for confirmed vulnerabilities.

## Scope

In scope:

- Code execution, file writes, or network access triggered by scanning a crafted file
- Reads outside the scan root, for example through symlinks or path traversal
- Denial of service from crafted input, such as catastrophic regex backtracking or
  unbounded memory use
- Terminal escape-sequence injection or report injection (SARIF, JSON, Markdown)
- Supply-chain issues in our published packages, release workflow, or GitHub Action

Out of scope:

- Security problems _inside_ the configuration files agentcheckup scans. Reporting
  those is agentcheckup's job; please open a normal issue if a rule misses one.
- Issues that require an already compromised machine or a malicious agentcheckup
  configuration file that you wrote yourself
