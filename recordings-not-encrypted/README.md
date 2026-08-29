# call recordings stored without encryption at rest

The question arrives in a spreadsheet from an auditor and it is one line: are call recordings encrypted at rest. Nobody knows. Recording was switched on years ago by whoever built the support queue, the files play fine in the console, and the answer turns out to be a field that is either present or absent on each recording &mdash; absent on all four years of them, because Voice Recording Encryption is opt-in and nobody opted in.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/recordings-not-encrypted/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_recording_encryption_audit.py
node node/twilio-recording-encryption-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_recording_encryption_audit.py
node --test node/twilio-recording-encryption-audit.test.mjs
```
