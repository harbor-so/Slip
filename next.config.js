/** @type {import("next").NextConfig} */
const config = {
	// postgres.js opens real sockets; it must stay external to the server bundle.
	serverExternalPackages: ["postgres"],

	webpack: (config) => {
		// The source imports with explicit `.js` extensions because that is what
		// Node's ESM resolver requires at runtime — `tsx` runs the MCP server and
		// the migration scripts directly, with no bundler in the path. TypeScript
		// understands that `./work.js` means `./work.ts`; webpack does not, and
		// would otherwise force the whole codebase to choose between being
		// bundler-correct and being runtime-correct.
		config.resolve.extensionAlias = {
			".js": [".ts", ".tsx", ".js"],
			".jsx": [".tsx", ".jsx"],
		};
		return config;
	},
};

export default config;
