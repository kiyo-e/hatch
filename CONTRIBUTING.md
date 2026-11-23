# Contributing to hatch

Thank you for your interest in contributing to **hatch**!

## Development Setup

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/kiyo-e/hatch.git
   cd hatch
   ```
2. Use the Node.js version specified in `.nvmrc` and install dependencies:
   ```bash
   nvm install && nvm use
   npm ci
   ```
3. Run type checking and tests:
   ```bash
   npm run typecheck
   npm test
   ```
4. To test locally with Wrangler:
   ```bash
   cp .dev.vars.example .dev.vars
   npm run dev
   ```

## Pull Request Guidelines

- Keep changes focused and small.
- Add or update tests in `test/` for any behavioral changes.
- Ensure `npm run typecheck` and `npm test` pass before opening a pull request.
- Do not commit secrets, `.dev.vars`, or environment-specific `wrangler.jsonc` routes/domain overrides.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
