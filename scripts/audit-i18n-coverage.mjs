import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dictionaryFiles = [
    'utils/i18n-main.zh.ts',
    'utils/i18n-views.zh.ts',
    'utils/i18n-entities.zh.ts',
    'utils/i18n-beats.zh.ts',
    'utils/i18n-extra.zh.ts',
    'utils/i18n.ts',
];

const decode = (quote, body) => {
    try {
        if (quote === '"') return JSON.parse(`"${body}"`);
        return body
            .replace(/\\u\{([0-9a-f]+)\}/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
            .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\'/g, "'")
            .replace(/\\\\/g, '\\');
    } catch {
        return body;
    }
};

const translations = new Set();
const entryPattern = /^\s*(['"])((?:\\.|(?!\1).)*)\1\s*:/gm;
for (const relativePath of dictionaryFiles) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    for (const match of source.matchAll(entryPattern)) translations.add(decode(match[1], match[2]));
}

const sourceFiles = [];
const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.name.endsWith('.ts')) sourceFiles.push(absolute);
    }
};
walk(root);

const missing = new Map();
const callPattern = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
for (const absolute of sourceFiles) {
    const source = fs.readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(callPattern)) {
        const key = decode(match[1], match[2]);
        if (translations.has(key)) continue;
        const line = source.slice(0, match.index).split('\n').length;
        missing.set(`${path.relative(root, absolute)}:${line}`, key);
    }
}

// Catch English UI literals that bypass t(). The former audit only checked
// strings already passed to t(), which allowed untranslated modals to report a
// clean bill of health. TypeScript's parser keeps this check precise enough to
// avoid treating authored content, CSS classes, URLs, and numeric examples as UI.
const uiSinkMethods = new Set([
    'setName', 'setDesc', 'setButtonText', 'setPlaceholder', 'setText', 'setTitle', 'setTooltip',
]);
const uiAttributeNames = new Set(['title', 'aria-label', 'placeholder']);
const uiPropertyNames = new Set(['textContent', 'innerText', 'placeholder', 'ariaLabel']);
const confirmModalPropertyNames = new Set(['title', 'message', 'confirmLabel', 'cancelLabel']);
const uiLiteralAllowlist = new Set(['Aa', 'Hn', 'Calibri']);
const isHumanUiLiteral = value => {
    const text = value.trim();
    if (!/[A-Za-z]{2}/.test(text)) return false;
    if (uiLiteralAllowlist.has(text)) return false;
    if (/^(?:https?:\/\/|cssclasses:|[.\w-]+\.(?:md|json|css|canvas|ncanvas))/.test(text)) return false;
    return true;
};
const isTCall = node => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 't';
const unsafeUiLiteral = expression => {
    if (!expression || isTCall(expression)) return null;
    if (ts.isStringLiteralLike(expression)) return isHumanUiLiteral(expression.text) ? expression : null;
    if (ts.isConditionalExpression(expression)) {
        return unsafeUiLiteral(expression.whenTrue) ?? unsafeUiLiteral(expression.whenFalse);
    }
    if (ts.isParenthesizedExpression(expression)) return unsafeUiLiteral(expression.expression);
    if (ts.isTemplateExpression(expression)) {
        const text = [expression.head.text, ...expression.templateSpans.map(span => span.literal.text)].join(' ');
        return isHumanUiLiteral(text) ? expression : null;
    }
    return null;
};
const propertyName = property => {
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
    return '';
};

for (const absolute of sourceFiles) {
    const source = fs.readFileSync(absolute, 'utf8');
    const sourceFile = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const report = (node, value) => {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        missing.set(`${path.relative(root, absolute)}:${position.line + 1}`, `UI literal bypasses t(): ${JSON.stringify(value)}`);
    };
    const visit = node => {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isPropertyAccessExpression(node.left) && uiPropertyNames.has(node.left.name.text)) {
            const unsafe = unsafeUiLiteral(node.right);
            if (unsafe) report(unsafe, unsafe.getText(sourceFile));
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
            && node.expression.text === 'openConfirmModal') {
            const options = node.arguments[1];
            if (options && ts.isObjectLiteralExpression(options)) {
                for (const property of options.properties) {
                    if (!ts.isPropertyAssignment(property)
                        || !confirmModalPropertyNames.has(propertyName(property))) continue;
                    const unsafe = unsafeUiLiteral(property.initializer);
                    if (unsafe) report(unsafe, unsafe.getText(sourceFile));
                }
            }
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            if (uiSinkMethods.has(method)) {
                const unsafe = unsafeUiLiteral(node.arguments[0]);
                if (unsafe) report(unsafe, unsafe.getText(sourceFile));
            }
            if (method === 'setAttribute' && ts.isStringLiteralLike(node.arguments[0])
                && uiAttributeNames.has(node.arguments[0].text)) {
                const unsafe = unsafeUiLiteral(node.arguments[1]);
                if (unsafe) report(unsafe, unsafe.getText(sourceFile));
            }
            if (['createEl', 'createDiv', 'createSpan'].includes(method)) {
                for (const argument of node.arguments) {
                    if (!ts.isObjectLiteralExpression(argument)) continue;
                    const textProperty = argument.properties.find(property =>
                        ts.isPropertyAssignment(property)
                        && propertyName(property) === 'text'
                    );
                    if (textProperty && ts.isPropertyAssignment(textProperty)) {
                        const unsafe = unsafeUiLiteral(textProperty.initializer);
                        if (unsafe) report(unsafe, unsafe.getText(sourceFile));
                    }
                    const attrProperty = argument.properties.find(property =>
                        ts.isPropertyAssignment(property) && propertyName(property) === 'attr'
                    );
                    if (attrProperty && ts.isPropertyAssignment(attrProperty)
                        && ts.isObjectLiteralExpression(attrProperty.initializer)) {
                        for (const attribute of attrProperty.initializer.properties) {
                            if (!ts.isPropertyAssignment(attribute)
                                || !uiAttributeNames.has(propertyName(attribute))) continue;
                            const unsafe = unsafeUiLiteral(attribute.initializer);
                            if (unsafe) report(unsafe, unsafe.getText(sourceFile));
                        }
                    }
                }
            }
        }
        if (ts.isNewExpression(node)
            && ((ts.isIdentifier(node.expression) && node.expression.text === 'Notice')
                || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'Notice'))) {
            const unsafe = unsafeUiLiteral(node.arguments?.[0]);
            if (unsafe) report(unsafe, unsafe.getText(sourceFile));
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
}

// Standard entity schemas are rendered through t(field.label/placeholder), so
// their string literals do not appear as literal t() calls. Audit them too.
const dynamicSchemaFiles = [
    'models/Codex.ts',
    'models/Character.ts',
    'models/Location.ts',
    'models/Scene.ts',
    'services/PlotlineNcanvasService.ts',
    'models/ProjectPages.ts',
    'components/ProjectModulePicker.ts',
];
const dynamicAllowlist = new Set(['{{title}}']);
const schemaStringPattern = /\b(?:label|title|placeholder)\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/g;
for (const relativePath of dynamicSchemaFiles) {
    const absolute = path.join(root, relativePath);
    const source = fs.readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(schemaStringPattern)) {
        const key = decode(match[1], match[2]);
        if (!/[A-Za-z]{2}/.test(key) || translations.has(key) || dynamicAllowlist.has(key)) continue;
        const line = source.slice(0, match.index).split('\n').length;
        missing.set(`${relativePath}:${line}`, key);
    }
}

if (missing.size > 0) {
    for (const [location, key] of missing) {
        if (key.startsWith('UI literal bypasses t():')) console.error(`${location}: ${key}`);
        else console.error(`${location}: missing Chinese translation for ${JSON.stringify(key)}`);
    }
    process.exitCode = 1;
} else {
    console.log(`All literal t() calls, standard UI schema strings, and checked UI sinks are covered by ${translations.size} Chinese translation keys.`);
}
