# Vayle

Vayle is an options venue for Stock Tokens on Robinhood Chain. Every option is fully collateralized, and exercise settles by transferring the actual Stock Token.

Status: in development. No contracts are deployed.

## Repository

| Path           | Contents                                                 |
| -------------- | -------------------------------------------------------- |
| `contracts/`   | Solidity contracts and tests, built with Foundry         |
| `packages/`    | Shared TypeScript packages                               |
| `services/`    | Offchain services                                        |
| `apps/`        | Web app and fallback interface                           |
| `tools/`       | Developer tools, like the local fork                     |
| `deployments/` | Chain facts and deployed addresses, each with its source |

[SETUP.md](SETUP.md) covers building and testing. [SECURITY.md](SECURITY.md) covers reporting a vulnerability. Licensed under MIT.
