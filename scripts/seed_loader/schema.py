"""Table/column schema the reseeding utility validates and maps against.

Column lists are transcribed from `Field_Dictionary.csv` / the public sample's own CSV headers
(`docs/CONTEXT.md` §12), not re-derived — this is the schema-driven contract `DATA_FLOW.md` §1/§6 and
`DECISIONS.md` ADR-006 require: map by column name, so the exact same code runs unchanged against the
hidden judging dataset as long as it matches this documented schema.

`natural_key` is the column each table upserts on (`DATA_FLOW.md` §6/§9) — used both for in-file exact-
duplicate collapsing and as the upsert merge key (Airtable's `performUpsert.fieldsToMergeOn`, or
Supabase's `?on_conflict=`, depending on `backend`).

`backend` picks which client loader.py writes the table through. Airtable is fully deprecated
(`DECISIONS.md` ADR-001's second amendment) — every table here is Supabase now. The field is kept
(rather than deleted) purely so a future re-split, if ever needed, is a one-line change per table
instead of reintroducing the concept from scratch.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import FrozenSet, Sequence


@dataclass(frozen=True)
class TableSchema:
    csv_file: str
    airtable_table: str
    natural_key: str
    columns: Sequence[str]
    name_fields: FrozenSet[str] = field(default_factory=frozenset)
    date_fields: FrozenSet[str] = field(default_factory=frozenset)
    numeric_fields: FrozenSet[str] = field(default_factory=frozenset)
    boolean_fields: FrozenSet[str] = field(default_factory=frozenset)
    # Which loader.py client writes this table. "airtable_table" keeps its name even for
    # Supabase-backed tables (the value is still the destination table name, just read by a
    # different client) — renaming it would touch loader.py/test_loader.py's already-tested
    # field-name references for a cosmetic gain only, so it's deliberately left as-is.
    backend: str = "supabase"  # "airtable" | "supabase" — see module docstring


TABLES = [
    TableSchema(
        csv_file="Workers.csv",
        airtable_table="Workers",
        natural_key="Employee_ID",
        backend="supabase",
        columns=[
            "Employee_ID", "Worker_WID", "Legal_Name", "Preferred_Name", "Business_Title",
            "Job_Profile", "Job_Family", "Management_Level", "Position_ID", "Manager_Name",
            "Manager_WID", "Cost_Center", "Location", "Hire_Date", "Worker_Type", "Time_Type",
            "FTE", "Email_Work", "jurisdiction", "time_zone", "work_auth_expiry", "cohort",
        ],
        # Legal_Name/Preferred_Name/Manager_Name are person names (DATA_FLOW.md §3 step 1 +
        # OP-01 step 1 "name casing"); Business_Title/Job_Profile etc. are left as normalize_text
        # only — title-casing an already-authored job title risks silently changing its meaning.
        name_fields=frozenset({"Legal_Name", "Preferred_Name", "Manager_Name"}),
        date_fields=frozenset({"Hire_Date", "work_auth_expiry"}),
        numeric_fields=frozenset({"FTE"}),
    ),
    TableSchema(
        csv_file="Onboarding_Tasks.csv",
        airtable_table="Onboarding_Tasks",
        natural_key="Event_ID",
        backend="supabase",
        columns=[
            "Event_ID", "Employee_ID", "Business_Process", "Step_Name", "Milestone",
            "Due_Date", "Status", "Completed_Date", "Assigned_To_Role",
        ],
        date_fields=frozenset({"Due_Date", "Completed_Date"}),
    ),
    TableSchema(
        csv_file="Provisioning_Integration.csv",
        airtable_table="Provisioning_Integration",
        natural_key="Integration_Event_ID",
        backend="supabase",
        columns=[
            "Integration_Event_ID", "Employee_ID", "Resource", "Requested_On", "Status", "Fulfilled_On",
        ],
        date_fields=frozenset({"Requested_On", "Fulfilled_On"}),
    ),
    TableSchema(
        csv_file="Peakon_Engagement.csv",
        airtable_table="Peakon_Engagement",
        natural_key="Response_ID",
        backend="supabase",
        columns=[
            "Response_ID", "Employee_ID", "Survey_Round", "Milestone", "Driver", "Score",
            "Comment", "Submitted_At", "sentiment", "x_confidential", "manager_response_days",
        ],
        date_fields=frozenset({"Submitted_At"}),
        numeric_fields=frozenset({"Score", "manager_response_days"}),
        boolean_fields=frozenset({"x_confidential"}),
    ),
    TableSchema(
        csv_file="Manager_Directory.csv",
        airtable_table="Manager_Directory",
        natural_key="Manager_WID",
        backend="supabase",
        columns=["Manager_WID", "Employee_ID", "Name", "Email_Work", "Org"],
        name_fields=frozenset({"Name"}),
    ),
    TableSchema(
        csv_file="Locations_Entities.csv",
        airtable_table="Locations_Entities",
        natural_key="entity_id",
        backend="supabase",
        columns=["entity_id", "name", "country", "jurisdiction", "timezone"],
    ),
    TableSchema(
        csv_file="Compliance_Items.csv",
        airtable_table="Compliance_Items",
        natural_key="item_id",
        backend="supabase",
        columns=["item_id", "employee_id", "doc_type", "jurisdiction", "due_date", "status"],
        date_fields=frozenset({"due_date"}),
    ),
    TableSchema(
        csv_file="Payroll_Records.csv",
        airtable_table="Payroll_Records",
        natural_key="payroll_id",
        backend="supabase",
        columns=["payroll_id", "employee_id", "cycle", "gross", "net", "status", "error_reason"],
        numeric_fields=frozenset({"gross", "net"}),
    ),
    TableSchema(
        csv_file="Learning_Milestones.csv",
        airtable_table="Learning_Milestones",
        natural_key="milestone_id",
        backend="supabase",
        columns=["milestone_id", "employee_id", "course", "due_day", "status"],
    ),
    TableSchema(
        csv_file="Attrition_History.csv",
        airtable_table="Attrition_History",
        natural_key="record_id",
        backend="supabase",
        columns=["record_id", "job_family", "tenure_days", "left_flag", "reason"],
        numeric_fields=frozenset({"tenure_days"}),
        boolean_fields=frozenset({"left_flag"}),
    ),
    TableSchema(
        csv_file="Cross_Team_Dependencies.csv",
        airtable_table="Cross_Team_Dependencies",
        natural_key="dep_id",
        backend="supabase",
        columns=["dep_id", "employee_id", "team", "task", "status", "blocks_day_one"],
        boolean_fields=frozenset({"blocks_day_one"}),
    ),
]
