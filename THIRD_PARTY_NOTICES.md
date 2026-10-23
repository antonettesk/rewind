# Third-party notices

Rewind is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`). It builds on the open-source work below. Each project keeps its own license, and the full texts ship in `node_modules/<package>/LICENSE` after `npm ci`.

| Component | Use in Rewind | License |
| --- | --- | --- |
| MCP TypeScript SDK (`@modelcontextprotocol/*`) | MCP server and clients | Apache-2.0 |
| Express | HTTP server | MIT |
| React, React Router | Web app | MIT |
| Motion | Animation | MIT |
| Tailwind CSS, Vite | Styling and build | MIT |
| Zod | Validation | MIT |
| jose | OpenID Connect token verification | MIT |
| qrcode | Two-factor QR codes | MIT |
| AWS SDK for JavaScript v3 (`@aws-sdk/*`) | Amazon Bedrock and Amazon Polly clients | Apache-2.0 |
| Hugging Face Transformers.js | On-device speech recognition | Apache-2.0 |
| ONNX Runtime Web | WebAssembly runtime for the speech model | MIT |
| Whisper (`onnx-community/whisper-tiny.en`, from OpenAI's Whisper) | Speech recognition model, downloaded by the browser at first use | MIT |
| Inter, JetBrains Mono (`@fontsource-variable/*`) | Typefaces | SIL Open Font License 1.1 |

Model weights are not stored in this repository; visitors' browsers download them from Hugging Face on first use of on-device recognition.

The interface chimes, icons, the "rewind dial" artwork and the share image are original to this project.

"Alexa", "Alexa+", "Amazon", "AWS", "Amazon Bedrock", "Amazon Nova" and "Amazon Polly" are trademarks of Amazon.com, Inc. or its affiliates. They are used here only to describe compatibility and integrations; Rewind is not affiliated with or endorsed by Amazon.
