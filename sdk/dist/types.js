// Core HATP v0.1 types. Mirrors spec/schemas/hatp.schema.json.
export class HatpError extends Error {
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
    }
}
