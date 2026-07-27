/**
 * Incremental text preparation for speech synthesis.
 *
 * This is deliberately not a general Markdown parser.  TTS needs to extract
 * readable prose from incomplete model output, so formatting markers are
 * discarded as soon as they are unambiguous and code/URLs are skipped across
 * input chunks.
 */

const STRONG_BOUNDARIES = new Set(["。", "！", "？", ".", "!", "?", "\n"]);
const MEDIUM_BOUNDARIES = new Set(["；", ";"]);
const WEAK_BOUNDARIES = new Set(["，", ",", "、", ":", "："]);
const URL_PREFIXES = ["http://", "https://"];

function isWhitespace(ch) {
    return ch == null || /\s/u.test(ch);
}

function isUrlPrefix(value) {
    return URL_PREFIXES.some((prefix) => prefix.startsWith(value));
}

function isUrl(value) {
    return URL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isUrlTerminator(ch, inLinkUrl) {
    if (isWhitespace(ch)) return true;
    if (inLinkUrl && ch === ")") return true;
    return /[，。！？；：、）》】〕〉»]/u.test(ch);
}

/**
 * Removes speech-irrelevant Markdown while retaining state between deltas.
 * In particular, an opening `**` does not need a later closing `**` before it
 * can be discarded.
 */
export class StreamingSpeechNormalizer {
    constructor() {
        this.reset();
    }

    reset() {
        this.inCodeFence = false;
        this.inInlineCode = false;
        this.pendingTicks = 0;
        this.pendingTag = "";
        this.pendingUrl = "";
        this.inUrl = false;
        this.inLinkUrl = false;
        this.afterLinkText = false;
        this.lineStart = true;
        this.needsSpace = false;
    }

    push(text) {
        if (!text) return "";
        const out = [];
        for (const ch of String(text)) {
            this._consume(ch, out);
        }
        return this._normalizeOutput(out.join(""));
    }

    flush() {
        const out = [];

        if (this.pendingTicks > 0) {
            // An unmatched backtick is formatting, not speech content.
            this.pendingTicks = 0;
        }
        if (this.pendingTag) {
            // Do not lose ordinary text if a '<' was not an HTML-like tag.
            if (!/^<\/?[A-Za-z][^>]*$/u.test(this.pendingTag)) {
                this._append(out, this.pendingTag);
            }
            this.pendingTag = "";
        }
        if (this.pendingUrl) {
            if (!isUrl(this.pendingUrl)) this._append(out, this.pendingUrl);
            this.pendingUrl = "";
        }

        this.inUrl = false;
        this.inLinkUrl = false;
        this.afterLinkText = false;
        this.inCodeFence = false;
        this.inInlineCode = false;
        return this._normalizeOutput(out.join(""));
    }

    _append(out, text) {
        if (!text) return;
        if (this.needsSpace && !isWhitespace(text[0])) {
            out.push(" ");
        }
        this.needsSpace = false;
        out.push(text);
        this.lineStart = /\n/u.test(text[text.length - 1]);
    }

    _consume(ch, out) {
        // A run of backticks is held so ``` split over two model deltas is
        // still recognized as a code fence.
        if (ch === "`") {
            this.pendingTicks++;
            return;
        }
        if (this.pendingTicks > 0) {
            const ticks = this.pendingTicks;
            this.pendingTicks = 0;
            if (ticks >= 3) {
                this.inCodeFence = !this.inCodeFence;
                this.inInlineCode = false;
                this.needsSpace = this.inCodeFence;
                // The current character belongs to the new state.
            }
            else if (ticks === 1 && !this.inCodeFence) {
                this.inInlineCode = !this.inInlineCode;
                this.needsSpace = this.inInlineCode;
                // The current character belongs to the new state.
            }
            // Two backticks are treated as formatting and discarded.
        }

        if (this.inCodeFence || this.inInlineCode) {
            if (ch === "\n") this.lineStart = true;
            return;
        }

        if (this.pendingTag) {
            this.pendingTag += ch;
            if (ch === ">") {
                if (/^<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s[^>]*)?\/?>(?:)$/u.test(this.pendingTag)) {
                    this.pendingTag = "";
                    return;
                }
                const tag = this.pendingTag;
                this.pendingTag = "";
                this._append(out, tag);
                return;
            }
            // Only hold a plausible HTML/tag prefix. A normal less-than
            // expression is released rather than swallowed with later text.
            if (this.pendingTag.length > 80 || /[\n]/u.test(this.pendingTag) || !/^<\/?[A-Za-z][A-Za-z0-9:_-]*/u.test(this.pendingTag)) {
                const tag = this.pendingTag;
                this.pendingTag = "";
                this._append(out, tag);
            }
            return;
        }
        if (ch === "<") {
            this.pendingTag = ch;
            return;
        }

        if (this.inUrl) {
            if (isUrlTerminator(ch, this.inLinkUrl)) {
                const wasWhitespace = isWhitespace(ch);
                this.inUrl = false;
                this.inLinkUrl = false;
                this.needsSpace = wasWhitespace;
                if (!wasWhitespace && ch !== ")") this._append(out, ch);
            }
            return;
        }

        if (this.pendingUrl) {
            const next = this.pendingUrl + ch;
            if (isUrlPrefix(next)) {
                this.pendingUrl = next;
                if (isUrl(next)) {
                    this.pendingUrl = "";
                    this.inUrl = true;
                }
                return;
            }
            this._append(out, this.pendingUrl);
            this.pendingUrl = "";
            this._consume(ch, out);
            return;
        }

        // Direct URLs are not useful when read character-by-character.  Hold
        // only the short prefix, so ordinary words beginning with 'h' incur
        // at most a one-character delay.
        if (ch === "h" && (this.lineStart || out.length === 0 || isWhitespace(out[out.length - 1]))) {
            this.pendingUrl = ch;
            return;
        }

        if (this.afterLinkText) {
            this.afterLinkText = false;
            if (ch === "(") {
                this.inUrl = true;
                this.inLinkUrl = true;
                return;
            }
            this._consume(ch, out);
            return;
        }

        // Markdown link brackets are formatting.  The label itself has
        // already been emitted; if it is followed by '(' skip the URL.
        if (ch === "]") {
            this.afterLinkText = true;
            return;
        }
        if (ch === "[") return;

        // Markdown emphasis, strike-through and list decoration.  These are
        // intentionally removed without waiting for a matching closing token.
        if (ch === "*" || ch === "_" || ch === "~") return;
        if (ch === "\\") {
            // Markdown escapes: keep the escaped character, discard the slash.
            return;
        }

        // Heading and blockquote markers at line start are not speech. Keep
        // comparison operators in ordinary prose (for example, "2 > 1").
        if (this.lineStart && (ch === "#" || ch === ">")) return;

        this._append(out, ch);
    }

    _normalizeOutput(text) {
        // Keep this per-delta normalization linear. Re-running global regexes
        // over a growing stream can monopolize the Node event loop during a
        // fast assistant response.
        let result = text.replace(/[ \t]+/gu, " ");
        result = result.replace(/ *\n */gu, "\n");
        result = result.replace(/[ \t]+([，。！？；：、,.!?;:])/gu, "$1");
        return result;
    }
}

/**
 * Incremental, conservative sentence/phrase chunker for HTTP TTS.
 */
export class SpeechSentenceChunker {
    constructor({ preferredLength = 42, maxLength = 90 } = {}) {
        this.preferredLength = preferredLength;
        this.maxLength = maxLength;
        this.buffer = "";
    }

    reset() {
        this.buffer = "";
    }

    push(text) {
        if (text) this.buffer += text;
        return this._drain(false);
    }

    flush() {
        return this._drain(true);
    }

    _drain(force) {
        const chunks = [];
        while (this.buffer) {
            let cut = -1;
            let boundary = "";
            for (let i = 0; i < this.buffer.length; i++) {
                const ch = this.buffer[i];
                if (STRONG_BOUNDARIES.has(ch)) {
                    cut = i + 1;
                    boundary = "strong";
                    break;
                }
                if (i + 1 >= this.preferredLength && MEDIUM_BOUNDARIES.has(ch)) {
                    cut = i + 1;
                    boundary = "medium";
                    break;
                }
                if (i + 1 >= this.preferredLength && WEAK_BOUNDARIES.has(ch)) {
                    cut = i + 1;
                    boundary = "weak";
                    break;
                }
            }

            if (cut < 0 && this.buffer.length >= this.maxLength) {
                cut = this._lastNaturalCut(this.maxLength);
                boundary = "length";
            }
            if (cut < 0 && force) {
                cut = this.buffer.length;
                boundary = "flush";
            }
            if (cut < 0) break;

            const chunk = this.buffer.slice(0, cut).trim();
            this.buffer = this.buffer.slice(cut);
            if (chunk) chunks.push({ text: chunk, boundary });
        }
        return chunks;
    }

    _lastNaturalCut(limit) {
        const end = Math.min(limit, this.buffer.length);
        for (let i = end - 1; i >= Math.floor(end * 0.55); i--) {
            if (MEDIUM_BOUNDARIES.has(this.buffer[i]) || WEAK_BOUNDARIES.has(this.buffer[i]) || /\s/u.test(this.buffer[i])) {
                return i + 1;
            }
        }
        return end;
    }
}

export class SpeechTextPipeline {
    constructor(options) {
        this.normalizer = new StreamingSpeechNormalizer();
        this.chunker = new SpeechSentenceChunker(options);
    }

    push(text) {
        return this.chunker.push(this.normalizer.push(text)).map(({ text: chunk }) => chunk);
    }

    flush() {
        const chunks = this.chunker.push(this.normalizer.flush());
        return chunks.concat(this.chunker.flush()).map(({ text: chunk }) => chunk);
    }

    reset() {
        this.normalizer.reset();
        this.chunker.reset();
    }
}
