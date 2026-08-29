from twilio_bundle_evaluation_audit import (failures, latest_evaluation,
                                              parse_date, staleness, verdict)

BUNDLE = {"sid": "BU00000000000000000000000000000002",
          "iso_country": "FR",
          "number_type": "national",
          "status": "draft",
          "date_updated": "2026-08-20T10:00:00Z"}

NONCOMPLIANT = {
    "sid": "EL00000000000000000000000000000001",
    "status": "noncompliant",
    "date_created": "2026-08-25T09:00:00Z",
    "results": [
        {"requirement_friendly_name": "Business Name",
         "requirement_name": "business_name_info",
         "object_type": "business",
         "passed": True,
         "invalid": []},
        {"requirement_friendly_name": "Business Identity",
         "requirement_name": "business_identity_info",
         "object_type": "business",
         "passed": False,
         "failure_reason": "one or more attributes are invalid",
         "invalid": [
             {"friendly_name": "Business Registration Number",
              "object_field": "business_registration_number",
              "failure_reason": "value does not match the expected format"},
             {"friendly_name": "Business Address Country",
              "object_field": "iso_country",
              "failure_reason": "address country does not match the regulation"},
         ]},
    ],
}


def test_failed_attributes_are_listed_one_per_field():
    rows = failures(NONCOMPLIANT)
    assert len(rows) == 2
    assert [r[2] for r in rows] == ["business_registration_number", "iso_country"]
    assert rows[0][0] == "Business Identity"
    assert "expected format" in rows[0][3]


def test_a_passing_requirement_is_not_reported():
    assert all(r[0] != "Business Name" for r in failures(NONCOMPLIANT))


def test_a_failure_with_no_invalid_entries_still_produces_a_row():
    # The missing-document case: nothing to name, and the most basic failure
    # there is. A reader that only walks invalid[] shows an empty report.
    evaluation = {"status": "noncompliant",
                  "results": [{"requirement_friendly_name": "Address",
                               "object_type": "supporting_document",
                               "passed": False,
                               "error_code": 22215,
                               "invalid": []}]}
    rows = failures(evaluation)
    assert len(rows) == 1
    assert rows[0][2] == "(no field named)"
    assert "22215" in rows[0][3]


def test_verdict_counts_the_attributes_rather_than_the_requirements():
    state, detail = verdict(NONCOMPLIANT)
    assert state == "noncompliant"
    assert "2 attribute(s)" in detail


def test_a_bundle_with_no_evaluation_is_its_own_state():
    state, detail = verdict(None)
    assert state == "never-evaluated"
    assert "free and exhaustive" in detail


def test_the_latest_run_is_chosen_by_date_not_by_position():
    old = {"sid": "EL1", "date_created": "2026-01-01T00:00:00Z"}
    new = {"sid": "EL2", "date_created": "2026-08-25T09:00:00Z"}
    assert latest_evaluation([new, old])["sid"] == "EL2"
    assert latest_evaluation([old, new])["sid"] == "EL2"
    assert latest_evaluation([]) is None


def test_a_compliant_run_older_than_the_last_edit_is_flagged_as_stale():
    compliant = {"status": "compliant", "date_created": "2026-08-01T00:00:00Z"}
    note = staleness(compliant, BUNDLE)
    assert note is not None
    assert "earlier version" in note
    fresh = {"status": "compliant", "date_created": "2026-08-25T09:00:00Z"}
    assert staleness(fresh, BUNDLE) is None


def test_dates_parse_with_a_trailing_z():
    assert parse_date("2026-08-25T09:00:00Z").hour == 9
    assert parse_date("") is None
    assert parse_date("not a date") is None
