# Contributing to Magpie CLIProxyAPI Plugin

Thank you for your interest in contributing to **Magpie CLIProxyAPI Plugin**! We welcome contributions, bug reports, feature suggestions, and documentation improvements from developers across the open-source community.

---

## Code of Conduct

We are committed to providing a welcoming, inclusive, and harassment-free experience for everyone. Please be respectful, constructive, and kind in all interactions.

---

## How to Contribute

### 1. Reporting Bugs
- Check existing issues before opening a new one to avoid duplicates.
- Provide a clear, descriptive title.
- Include reproduction steps, environment details (OS, Magpie version, Node.js version), and relevant error logs.

### 2. Suggesting Enhancements
- Explain the problem your proposed feature solves.
- Describe the expected behavior and how it benefits users with different Magpie or AI client setups.

### 3. Submitting Pull Requests (PRs)
1. Fork the repository and create a new feature branch (`git checkout -b feature/your-feature-name`).
2. Implement your changes adhering to existing code conventions (ES modules, clean async/await, no external runtime bloat).
3. Ensure automated tests pass:
   ```bash
   npm test
   ```
4. If you introduce new features, add corresponding unit tests under the `test/` directory.
5. Commit your changes with a concise commit message.
6. Push to your branch (`git push origin feature/your-feature-name`) and open a Pull Request.

---

## Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/terenceooit/magpie-cli-proxy-api-plugin.git
   cd magpie-cli-proxy-api-plugin
   ```

2. **Run tests:**
   Node.js built-in test runner is used (no heavy dependencies required):
   ```bash
   npm test
   ```

3. **Link to Magpie:**
   Add the repository path to your Magpie `plugins.json` (under `~/.config/magpie/plugins.json`):
   ```json
   {
     "plugins": [
       {
         "spec": "path/to/magpie-cli-proxy-api-plugin"
       }
     ]
   }
   ```

---

## Supporting the Project

If this project helps your daily workflow, consider buying the author a coffee or tipping via Wise:

☕ **[Tip via Wise - Terence Ooi Teng Wei (@terenceooit)](https://wise.com/pay/me/terenceooit)**

Your support is deeply appreciated and helps maintain open-source tools!
