# a rejected toll-free verification is fixable or it is not

The verification was filed, it came back TWILIO_REJECTED, somebody read the prose, changed a sentence in the use-case summary and resubmitted. It was rejected again. The reason is a code, the code says the business category is one Twilio will not carry on US and Canadian SMS routes at all, and no edit to the summary was ever going to change that. Meanwhile the window in which cheap edits were possible has been spent on them.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/tollfree-verification-rejected/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_tollfree_rejection_audit.py
node node/twilio-tollfree-rejection-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_tollfree_rejection_audit.py
node --test node/twilio-tollfree-rejection-audit.test.mjs
```
