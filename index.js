import fs from 'node:fs';
import merge2 from 'merge2';
import fastGlob from 'fast-glob';
import dirGlob from 'dir-glob';
import {isGitIgnored, isGitIgnoredSync} from './gitignore.js';
import {FilterStream, toPath} from './utilities.js';

const isNegative = pattern => pattern[0] === '!';

const assertPatternsInput = patterns => {
	if (!patterns.every(pattern => typeof pattern === 'string')) {
		throw new TypeError('Patterns must be a string or an array of strings');
	}
};

const toPatternsArray = patterns => {
	patterns = [...new Set([patterns].flat())];
	assertPatternsInput(patterns);
	return patterns;
};

const checkCwdOption = options => {
	if (!options.cwd) {
		return;
	}

	let stat;
	try {
		stat = fs.statSync(options.cwd);
	} catch {
		return;
	}

	if (!stat.isDirectory()) {
		throw new Error('The `cwd` option must be a path to a directory');
	}
};

const normalizeOptions = (options = {}) => {
	options = {
		ignore: [],
		expandDirectories: true,
		...options,
		cwd: toPath(options.cwd),
	};

	checkCwdOption(options);

	return options;
};

const normalizeArguments = fn => async (patterns, options) => fn(toPatternsArray(patterns), normalizeOptions(options));
const normalizeArgumentsSync = fn => (patterns, options) => fn(toPatternsArray(patterns), normalizeOptions(options));

const getFilter = async options => createFilterFunction(
	options.gitignore && await isGitIgnored({cwd: options.cwd, ignore: options.ignore}),
);
const getFilterSync = options => createFilterFunction(
	options.gitignore && isGitIgnoredSync({cwd: options.cwd, ignore: options.ignore}),
);
const createFilterFunction = isIgnored => {
	const seen = new Set();

	return fastGlobResult => {
		const path = fastGlobResult.path || fastGlobResult;
		const seenOrIgnored = seen.has(path) || (isIgnored && isIgnored(path));
		seen.add(path);
		return !seenOrIgnored;
	};
};

const unionFastGlobResults = (results, filter) => results.flat().filter(fastGlobResult => filter(fastGlobResult));
const unionFastGlobStreams = (streams, filter) => merge2(streams).pipe(new FilterStream(fastGlobResult => filter(fastGlobResult)));

const convertNegativePatternsToIgnore = patterns => {
	const tasks = [];
	for (const [index, pattern] of patterns.entries()) {
		if (isNegative(pattern)) {
			continue;
		}

		const ignore = patterns
			.slice(index)
			.filter(pattern => isNegative(pattern))
			.map(pattern => pattern.slice(1));

		tasks.push({patterns: [pattern], ignore});
	}

	return tasks;
};

const getDirGlobOptions = (options, cwd) => ({
	...(cwd ? {cwd} : {}),
	...(Array.isArray(options) ? {files: options} : options),
});

const createTaskOptions = (options, ignore) => ({...options, ignore: [...options.ignore, ...ignore]});
const generateTasks = async (patterns, options) => {
	const tasks = convertNegativePatternsToIgnore(patterns);
	const {cwd, expandDirectories} = options;

	if (!expandDirectories) {
		return tasks.map(({patterns, ignore}) => ({patterns, options: createTaskOptions(options, ignore)}));
	}

	const ignoreExpandOptions = cwd ? {cwd} : undefined;
	const patternExpandOptions = getDirGlobOptions(expandDirectories, cwd);

	options.ignore = await dirGlob(options.ignore, ignoreExpandOptions);
	return Promise.all(
		tasks.map(async task => {
			let {patterns, ignore} = task;

			[
				patterns,
				ignore,
			] = await Promise.all([
				dirGlob(patterns, patternExpandOptions),
				dirGlob(ignore, ignoreExpandOptions),
			]);

			return {patterns, options: createTaskOptions(options, ignore)};
		}),
	);
};

const generateTasksSync = (patterns, options) => {
	const tasks = convertNegativePatternsToIgnore(patterns);
	const {cwd, expandDirectories} = options;

	if (!expandDirectories) {
		return tasks.map(({patterns, ignore}) => ({patterns, options: createTaskOptions(options, ignore)}));
	}

	const ignoreExpandOptions = cwd ? {cwd} : undefined;
	const patternExpandOptions = getDirGlobOptions(expandDirectories, cwd);

	options.ignore = dirGlob.sync(options.ignore, ignoreExpandOptions);

	return tasks.map(task => {
		let {patterns, ignore} = task;
		patterns = dirGlob.sync(patterns, patternExpandOptions);
		ignore = dirGlob.sync(ignore, ignoreExpandOptions);

		return {patterns, options: createTaskOptions(options, ignore)};
	});
};

export const globby = normalizeArguments(async (patterns, options) => {
	const [
		tasks,
		filter,
	] = await Promise.all([
		generateTasks(patterns, options),
		getFilter(options),
	]);
	const results = await Promise.all(tasks.map(task => fastGlob(task.patterns, task.options)));

	return unionFastGlobResults(results, filter);
});

export const globbySync = normalizeArgumentsSync((patterns, options) => {
	const tasks = generateTasksSync(patterns, options);
	const filter = getFilterSync(options);
	const results = tasks.map(task => fastGlob.sync(task.patterns, task.options));

	return unionFastGlobResults(results, filter);
});

export const globbyStream = normalizeArgumentsSync((patterns, options) => {
	const tasks = generateTasksSync(patterns, options);
	const filter = getFilterSync(options);
	const streams = tasks.map(task => fastGlob.stream(task.patterns, task.options));

	return unionFastGlobStreams(streams, filter);
});

export const isDynamicPattern = normalizeArgumentsSync(
	(patterns, options) => patterns.some(pattern => fastGlob.isDynamicPattern(pattern, options)),
);

export const generateGlobTasks = normalizeArguments(generateTasks);
export const generateGlobTasksSync = normalizeArgumentsSync(generateTasksSync);

export {
	isGitIgnored,
	isGitIgnoredSync,
} from './gitignore.js';
