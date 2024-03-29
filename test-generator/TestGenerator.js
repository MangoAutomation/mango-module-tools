/*
 * Copyright (C) 2023 Radix IoT LLC. All rights reserved.
 */

const fs = require('fs');
const path = require('path');
const {dashCase} = require('./util');
const Handlebars = require('handlebars');

class TestGenerator {
    constructor(options) {
        Object.assign(this, options);

        this.handlebars = Handlebars.create();

        this.handlebars.registerHelper('eq', (a, b) => a === b);
        this.handlebars.registerHelper('or', (...args) => args.slice(0, -1).some(a => a));
        this.handlebars.registerHelper('and', (...args) => args.slice(0, -1).every(a => a));
        this.handlebars.registerHelper('join', (...args) => args.slice(0, -1).join(''));
        this.handlebars.registerHelper('json', (input, spaces) => JSON.stringify(input, null, spaces));

        this.handlebars.registerHelper('find_body_schema', (parameters) => parameters.find(p => p.in === 'body').schema);
        this.handlebars.registerHelper('has_param_type', (parameters, type) => parameters && parameters.some(p => p.in === type));
        this.handlebars.registerHelper('filter_by_param_type', (parameters, type) => parameters && parameters.filter(p => p.in === type) || []);

        this.handlebars.registerHelper('find_success_response', (responses) => {
            return Object.entries(responses || {}).map(([status, response]) => {
                return Object.assign({status}, response);
            }).filter(response => {
                return response.status >= 200 && response.status < 300;
            }).find(r => !!r);
        });

        this.handlebars.registerHelper('print_schema', (schema, options) => {
            return this.printSchema(schema, options.loc.start.column);
        });

        this.handlebars.registerHelper('get_schema', (ref, options) => {
            return this.getSchema(ref);
        });

        this.handlebars.registerHelper('schemas_for_paths', (paths) => {
            return this.schemasForPaths(paths);
        });

        const paramValue = function(param) {
            if (param.hasOwnProperty('default')) {
                return typeof param.default === 'string' ? `'${param.default}'` : param.default;
            }
            if (Array.isArray(param.enum) && param.enum.length) {
                return `'${param.enum[0]}'`;
            }
            if (param.type === 'string' && param.name === 'xid') {
                return 'this.test.xid';
            }
            if (param.in === 'body') {
                return 'requestBody';
            }
            switch(param.type) {
            case 'string': return `'string'`;
            case 'integer': return '0';
            case 'number': return '0.0';
            case 'boolean': return 'true';
            case 'array': return param.items ? `[${paramValue(param.items)}]` : '[]';
            default: return 'undefined';
            }
        };

        this.handlebars.registerHelper('param_value', paramValue);

        this.handlebars.registerHelper('get_path_params', path => {
            const results = {};
            const regex = /{(.+?)}/g;
            let match;
            while((match = regex.exec(path)) != null) {
                results[match[1]] = 'uuid()';
            }
            return results
        });

        this.handlebars.registerHelper('replace_path_params', path => {
            return path.replace(/{(.+?)}/g, '${params.$1}');
        });

        const fileTemplate = fs.readFileSync(this.fileTemplate, 'utf-8');
        const testTemplate = fs.readFileSync(this.testTemplate, 'utf-8');
        const assertTemplate = fs.readFileSync(this.assertTemplate, 'utf-8');

        this.handlebars.registerPartial('test', testTemplate);
        this.handlebars.registerPartial('assert', assertTemplate);
        this.compiledTemplate = this.handlebars.compile(fileTemplate, {noEscape: true});

        this.fileNameTemplate = this.handlebars.compile(this.fileName, {noEscape: true, strict: true});
    }

    getSchema(ref) {
        const matches = /^#\/definitions\/(.*)$/.exec(ref);
        const defName = matches && matches[1];
        return this.apiDocs.definitions[defName];
    }

    getAllSchemas(schema, schemas = new Set()) {
        if (schema.$ref) {
            schema = this.getSchema(schema.$ref);
        }
        if (schemas.has(schema)) {
            return schemas;
        }
        if (schema.type === 'object') {
            if (schema.title) {
                schemas.add(schema);
            }
            if (schema.properties) {
                Object.values(schema.properties).forEach(propertySchema => {
                    this.getAllSchemas(propertySchema, schemas);
                });
            }
        } else if (schema.type === 'array') {
            if (schema.items) {
                this.getAllSchemas(schema.items, schemas);
            }
        }
        return schemas;
    }

    schemasForPaths(paths) {
        const schemas = paths.reduce((responses, path) => {
            return responses.concat(Object.values(path.responses));
        }, []).reduce((schemas, response) => {
            if (response.schema) {
                this.getAllSchemas(response.schema, schemas);
            }
            return schemas;
        }, new Set());

        return Array.from(schemas);
    }

    printSchema(schema, spaces = 0, depth = 0) {
        if (depth >= 20) {
            return `// RECURSION DEPTH EXCEEDED ${depth}`;
        }

        if (schema.$ref) {
            const referencedSchema = this.getSchema(schema.$ref);
            if (!referencedSchema) {
                return `// UNKNOWN SCHEMA REF ${schema.$ref}`;
            }
            return this.printSchema(referencedSchema, spaces, depth + 1);
        }

        const linePrefix = ''.padStart(spaces);
        const lines = [];

        if (schema.type === 'object') {
            lines.push(`{ // title: ${schema.title}`);
            if (schema.properties) {
                const required = new Set(schema.required || []);

                Object.entries(schema.properties)
                .filter(([key, value]) => !this.requiredPropertiesOnly || required.has(key))
                .forEach(([key, value], index, array) => {
                    const last = index === array.length - 1;
                    const comma = last ? '' : ',';
                    lines.push(`    ${key}: ${this.printSchema(value, spaces + 4, depth + 1)}${comma}`);
                });
            }
            lines.push('}');
        } else if (schema.type === 'array') {
            lines.push('[');
            lines.push('    ' + this.printSchema(schema.items, spaces + 4, depth + 1));
            lines.push(']');
        } else if (schema.type === 'boolean') {
            lines.push('false');
        } else if (schema.type === 'integer') {
            lines.push('0');
        } else if (schema.type === 'number') {
            lines.push('0.0');
        } else if (schema.type === 'string') {
            lines.push(Array.isArray(schema['enum']) ? `'${schema.enum[0]}'` : `'string'`);
        } else {
            lines.push(`// UNKNOWN SCHEMA TYPE ${schema.type}`);
        }

        return lines.join(`\n${linePrefix}`);
    }

    generateTests(tagNames, methods, pathMatch) {
        if (!tagNames) tagNames = this.apiDocs.tags.map(t => t.name);
        return Promise.all(tagNames.map(t => this.generateTestsSingle(t, methods, pathMatch)));
    }

    generateTestsSingle(tagName, methodsArray, pathMatch) {
        const tag = this.apiDocs.tags.find(t => t.name === tagName);
        if (!tag) throw new Error(`Tag name '${tagName}' not found in Swagger API documentation`);

        const paths = [];
        Object.entries(this.apiDocs.paths).forEach(([path, methods]) => {
            if (!pathMatch || pathMatch.test(this.apiDocs.basePath + path)) {
                Object.entries(methods).forEach(([method, description]) => {
                    if (!methodsArray || methodsArray.some(m => m.toLowerCase() === method)) {
                        if (description.tags.includes(tagName)) {
                            paths.push(Object.assign({path, method: method.toUpperCase()}, description));
                        }
                    }
                });
            }
        });

        const fileResult = this.compiledTemplate({
            apiDocs: this.apiDocs,
            tag,
            paths
        });

        const fileName = this.fileNameTemplate({
            apiDocs: this.apiDocs,
            tag,
            basePath: dashCase(this.apiDocs.basePath, '/').slice(1)
        });

        const filePath = path.resolve(this.directory, fileName);
        fs.writeFileSync(filePath, fileResult, {flag: this.overwrite ? 'w' : 'wx'});
    }
}

module.exports = TestGenerator;
