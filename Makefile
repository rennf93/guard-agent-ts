.PHONY: install build clean test test-coverage lint typecheck bump-version prune

install:
	pnpm install

build:
	pnpm build

clean:
	pnpm clean

test:
	pnpm test

test-coverage:
	pnpm test:coverage

lint:
	pnpm lint

typecheck: lint

bump-version:
	@if [ -z "$(VERSION)" ]; then echo "Usage: make bump-version VERSION=x.y.z"; exit 1; fi
	node .github/scripts/bump-version.mjs $(VERSION)

prune:
	find . -name "node_modules" -type d -prune -exec rm -rf {} + 2>/dev/null || true
	find . -name "dist" -type d -prune -exec rm -rf {} + 2>/dev/null || true
	find . -name "coverage" -type d -prune -exec rm -rf {} + 2>/dev/null || true
