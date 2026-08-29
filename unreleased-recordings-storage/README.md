# recordings billed for storage until something deletes them

Somebody enabled recording on a support line in 2022, wrote the code that downloads each file into your own bucket, and never wrote the line that deletes the Twilio-side copy. Every one of those recordings is still there. You are paying to store all of them, every month, and the charge is a small enough line on the invoice that it has survived four years of expense reviews.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/unreleased-recordings-storage/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_recording_storage_audit.py
node node/twilio-recording-storage-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_recording_storage_audit.py
node --test node/twilio-recording-storage-audit.test.mjs
```
