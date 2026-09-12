const fs = require('node:fs');
const path = require('node:path');
module.exports = function buildNotices(directories) {
  const entries = directories.map(directory => {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const license = fs.readdirSync(directory).find(name => /^licen[sc]e(?:\.md|\.txt)?$/i.test(name));
    if (!license) throw new Error(`Missing license text for bundled package ${pkg.name}`);
    return `## ${pkg.name} ${pkg.version} (${pkg.license})\n\n${fs.readFileSync(path.join(directory, license), 'utf8').trim()}\n`;
  }).sort();
  return '# Third-party notices\n\nThe following dependency code is bundled into main.js and retains these licenses.\n\n' + entries.join('\n');
};
