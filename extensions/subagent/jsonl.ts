import { StringDecoder } from "node:string_decoder";

/** Strict LF-delimited JSON decoder. U+2028/U+2029 remain valid JSON string content. */
export class JsonLineDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";

	push(chunk: Buffer | Uint8Array | string): string[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
		return this.takeCompleteLines();
	}

	end(chunk?: Buffer | Uint8Array | string): string[] {
		if (chunk !== undefined) this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
		this.buffer += this.decoder.end();
		const lines = this.takeCompleteLines();
		if (this.buffer.length > 0) {
			lines.push(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
			this.buffer = "";
		}
		return lines;
	}

	private takeCompleteLines(): string[] {
		const lines: string[] = [];
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			let line = this.buffer.slice(0, index);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			lines.push(line);
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
		}
		return lines;
	}
}
