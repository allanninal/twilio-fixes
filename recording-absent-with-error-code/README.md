# a recording row says absent and there is no media behind it

Someone in compliance asks for the call from the fourteenth. The recording is in the list, with a SID, a date and a call SID beside it. The media URL returns 404. Its status is absent, its error_code is populated, and it has been sitting there like that for six weeks because nothing in the system treats a row that exists as a recording that does not.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/recording-absent-with-error-code/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_absent_recordings_audit.py
node node/twilio-absent-recordings-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_absent_recordings_audit.py
node --test node/twilio-absent-recordings-audit.test.mjs
```
