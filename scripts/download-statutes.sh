#!/bin/bash
# Download NC General Statutes for legal research library
# Pulls full chapter HTML from ncleg.gov and converts to readable text

RESEARCH_DIR="/Users/jacobmolz/cowork/sofi/07_Research/statutes"
TEMP_DIR="/tmp/nc-statutes-download"
mkdir -p "$RESEARCH_DIR" "$TEMP_DIR"

BASE_URL="https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByChapter"
SECTION_BASE="https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection"

# Chapters relevant to the case
declare -A CHAPTERS
CHAPTERS[1]="Civil_Procedure"
CHAPTERS[1A]="Rules_of_Civil_Procedure"
CHAPTERS[7A]="Judicial_Department"
CHAPTERS[58]="Insurance"
CHAPTERS[75]="Consumer_Protection"
CHAPTERS[32C]="Uniform_Power_of_Attorney_Act"
CHAPTERS[8C]="Evidence_Code"

echo "=== NC General Statutes Downloader ==="
echo "Target: $RESEARCH_DIR"
echo ""

# Download full chapter HTML files
for ch in "${!CHAPTERS[@]}"; do
    name="${CHAPTERS[$ch]}"
    url="${BASE_URL}/Chapter_${ch}.html"
    outfile="$RESEARCH_DIR/Chapter_${ch}_${name}.html"
    
    echo "Downloading Chapter ${ch} - ${name}..."
    curl -sL -o "$outfile" "$url"
    
    if [ -f "$outfile" ] && [ -s "$outfile" ]; then
        size=$(wc -c < "$outfile" | tr -d ' ')
        echo "  ✓ Chapter ${ch}: ${size} bytes"
    else
        echo "  ✗ Chapter ${ch}: FAILED or empty"
    fi
done

echo ""
echo "=== Downloading Individual Key Sections ==="

# Key individual sections we need quick access to
declare -A SECTIONS
# Chapter 1 - SOL
SECTIONS["1/GS_1-15"]="Limitation-Personal-Actions"
SECTIONS["1/GS_1-52"]="Three-Year-SOL"
SECTIONS["1/GS_1-53"]="Ten-Year-SOL"
SECTIONS["1/GS_1-56"]="Counterclaims-SOL"
# Chapter 1A - Rules of Civil Procedure
SECTIONS["1A/GS_1A-1,_Rule_3"]="Commencement-of-Action"
SECTIONS["1A/GS_1A-1,_Rule_4"]="Process"
SECTIONS["1A/GS_1A-1,_Rule_5"]="Service-Filing-Pleadings"
SECTIONS["1A/GS_1A-1,_Rule_6"]="Time"
SECTIONS["1A/GS_1A-1,_Rule_7"]="Pleadings"
SECTIONS["1A/GS_1A-1,_Rule_8"]="General-Rules-Pleading"
SECTIONS["1A/GS_1A-1,_Rule_9"]="Pleading-Special-Matters"
SECTIONS["1A/GS_1A-1,_Rule_10"]="Form-Pleadings"
SECTIONS["1A/GS_1A-1,_Rule_11"]="Signing-Verification"
SECTIONS["1A/GS_1A-1,_Rule_12"]="Defenses-Objections"
SECTIONS["1A/GS_1A-1,_Rule_13"]="Counterclaim-Crossclaim"
SECTIONS["1A/GS_1A-1,_Rule_14"]="Third-Party-Practice"
SECTIONS["1A/GS_1A-1,_Rule_15"]="Amended-Supplemental-Pleadings"
SECTIONS["1A/GS_1A-1,_Rule_16"]="Pre-Trial-Procedure"
SECTIONS["1A/GS_1A-1,_Rule_17"]="Parties-Plaintiff-Defendant"
SECTIONS["1A/GS_1A-1,_Rule_18"]="Joinder-Claims"
SECTIONS["1A/GS_1A-1,_Rule_19"]="Necessary-Joinder-Parties"
SECTIONS["1A/GS_1A-1,_Rule_20"]="Permissive-Joinder"
SECTIONS["1A/GS_1A-1,_Rule_21"]="Misjoinder-Nonjoinder"
SECTIONS["1A/GS_1A-1,_Rule_22"]="Interpleader"
SECTIONS["1A/GS_1A-1,_Rule_23"]="Class-Actions"
SECTIONS["1A/GS_1A-1,_Rule_24"]="Intervention"
SECTIONS["1A/GS_1A-1,_Rule_25"]="Substitution-Parties"
SECTIONS["1A/GS_1A-1,_Rule_26"]="Discovery-General"
SECTIONS["1A/GS_1A-1,_Rule_27"]="Depositions-Before-Action"
SECTIONS["1A/GS_1A-1,_Rule_28"]="Persons-Before-Whom-Depositions"
SECTIONS["1A/GS_1A-1,_Rule_29"]="Stipulations-Discovery"
SECTIONS["1A/GS_1A-1,_Rule_30"]="Depositions-Oral-Examination"
SECTIONS["1A/GS_1A-1,_Rule_31"]="Depositions-Written-Questions"
SECTIONS["1A/GS_1A-1,_Rule_32"]="Use-Depositions"
SECTIONS["1A/GS_1A-1,_Rule_33"]="Interrogatories"
SECTIONS["1A/GS_1A-1,_Rule_34"]="Production-Documents"
SECTIONS["1A/GS_1A-1,_Rule_35"]="Physical-Mental-Examination"
SECTIONS["1A/GS_1A-1,_Rule_36"]="Requests-Admission"
SECTIONS["1A/GS_1A-1,_Rule_37"]="Discovery-Sanctions"
SECTIONS["1A/GS_1A-1,_Rule_38"]="Jury-Trial-Right"
SECTIONS["1A/GS_1A-1,_Rule_39"]="Trial-By-Jury"
SECTIONS["1A/GS_1A-1,_Rule_40"]="Assignment-Cases-Trial"
SECTIONS["1A/GS_1A-1,_Rule_41"]="Dismissal-Actions"
SECTIONS["1A/GS_1A-1,_Rule_42"]="Consolidation-Separate-Trials"
SECTIONS["1A/GS_1A-1,_Rule_43"]="Evidence"
SECTIONS["1A/GS_1A-1,_Rule_44"]="Proof-Official-Record"
SECTIONS["1A/GS_1A-1,_Rule_45"]="Subpoena"
SECTIONS["1A/GS_1A-1,_Rule_46"]="Exceptions-Unnecessary"
SECTIONS["1A/GS_1A-1,_Rule_47"]="Jurors"
SECTIONS["1A/GS_1A-1,_Rule_48"]="Juries-Six"
SECTIONS["1A/GS_1A-1,_Rule_49"]="Verdicts"
SECTIONS["1A/GS_1A-1,_Rule_50"]="Directed-Verdict-JNOV"
SECTIONS["1A/GS_1A-1,_Rule_51"]="Instructions-Jury"
SECTIONS["1A/GS_1A-1,_Rule_52"]="Findings-by-Court"
SECTIONS["1A/GS_1A-1,_Rule_53"]="Referees"
SECTIONS["1A/GS_1A-1,_Rule_54"]="Judgments"
SECTIONS["1A/GS_1A-1,_Rule_55"]="Default"
SECTIONS["1A/GS_1A-1,_Rule_56"]="Summary-Judgment"
SECTIONS["1A/GS_1A-1,_Rule_57"]="Declaratory-Judgments"
SECTIONS["1A/GS_1A-1,_Rule_58"]="Entry-of-Judgment"
SECTIONS["1A/GS_1A-1,_Rule_59"]="New-Trials-Amendment"
SECTIONS["1A/GS_1A-1,_Rule_60"]="Relief-from-Judgment"
SECTIONS["1A/GS_1A-1,_Rule_61"]="Harmless-Error"
SECTIONS["1A/GS_1A-1,_Rule_62"]="Stay-Proceedings"
SECTIONS["1A/GS_1A-1,_Rule_63"]="Disability-Judge"
SECTIONS["1A/GS_1A-1,_Rule_64"]="Seizure-Property"
SECTIONS["1A/GS_1A-1,_Rule_65"]="Injunctions"
SECTIONS["1A/GS_1A-1,_Rule_68"]="Offer-Judgment"
# Chapter 7A - Jurisdiction
SECTIONS["7A/GS_7A-240"]="Definitions-Civil-Actions"
SECTIONS["7A/GS_7A-241"]="Unlimited-Jurisdiction"
SECTIONS["7A/GS_7A-242"]="Original-Jurisdiction-Superior"
SECTIONS["7A/GS_7A-243"]="Proper-Division-Amount"
SECTIONS["7A/GS_7A-244"]="Waiver-Proper-Division"
SECTIONS["7A/GS_7A-245"]="Concurrent-Jurisdiction-Special"
SECTIONS["7A/GS_7A-246"]="Exclusive-Jurisdiction-District"
SECTIONS["7A/GS_7A-247"]="Jurisdiction-Small-Claims"
SECTIONS["7A/GS_7A-248"]="Counterclaims-Effect"
SECTIONS["7A/GS_7A-249"]="Joinder-Effect"
SECTIONS["7A/GS_7A-250"]="Jurisdiction-Uncontested"
SECTIONS["7A/GS_7A-251"]="Exclusive-Jurisdiction-Probate"
SECTIONS["7A/GS_7A-252"]="Appeals-Admin-Agencies"
SECTIONS["7A/GS_7A-253"]="Proper-Venue"
SECTIONS["7A/GS_7A-254"]="Consolidation-Actions"
SECTIONS["7A/GS_7A-255"]="Change-Venue"
SECTIONS["7A/GS_7A-256"]="Transfer-Cases-Between"
SECTIONS["7A/GS_7A-257"]="Transfer-Improper-County"
SECTIONS["7A/GS_7A-258"]="Motion-to-Transfer"
SECTIONS["7A/GS_7A-259"]="Procedure-Upon-Transfer"
# Chapter 58 - Collection Agency Act
SECTIONS["58/GS_58-70-1"]="Collection-Agency-Definitions"
SECTIONS["58/GS_58-70-15"]="Collection-Agency-Permit-Required"
SECTIONS["58/GS_58-70-70"]="Collection-Agency-Prohibited-Acts"
SECTIONS["58/GS_58-70-90"]="Collection-Agency-Civil-Liability"
SECTIONS["58/GS_58-70-115"]="Debt-Buyer-Definition"
SECTIONS["58/GS_58-70-120"]="Debt-Buyer-Registration"
SECTIONS["58/GS_58-70-125"]="Debt-Buyer-Collection-Restrictions"
SECTIONS["58/GS_58-70-130"]="Debt-Buyer-Required-Disclosures"
SECTIONS["58/GS_58-70-145"]="Debt-Buyer-Statute-Limitations"
SECTIONS["58/GS_58-70-150"]="Debt-Buyer-Litigation"
SECTIONS["58/GS_58-70-155"]="Debt-Buyer-Documentation-Required"
# Chapter 75 - NC Debt Collection Act
SECTIONS["75/GS_75-50"]="Debt-Collection-Definitions"
SECTIONS["75/GS_75-51"]="Debt-Collection-Communication"
SECTIONS["75/GS_75-52"]="Debt-Collection-Deception"
SECTIONS["75/GS_75-53"]="Debt-Collection-Threats"
SECTIONS["75/GS_75-54"]="Debt-Collection-Unfair-Practices"
SECTIONS["75/GS_75-55"]="Debt-Collection-Remedies"
SECTIONS["75/GS_75-56"]="Debt-Collection-Penalties"
# Chapter 32C - Power of Attorney
SECTIONS["32C/GS_32C-1-102"]="POA-Definitions"
SECTIONS["32C/GS_32C-1-110"]="POA-Agent-Duties"
SECTIONS["32C/GS_32C-1-114"]="POA-Agent-Liability"
SECTIONS["32C/GS_32C-2-201"]="POA-Authority-Agent"
SECTIONS["32C/GS_32C-2-205"]="POA-Termination"

echo ""
count=0
total=${#SECTIONS[@]}
for key in "${!SECTIONS[@]}"; do
    count=$((count + 1))
    chapter=$(echo "$key" | cut -d'/' -f1)
    section=$(echo "$key" | cut -d'/' -f2)
    name="${SECTIONS[$key]}"
    
    url="${SECTION_BASE}/Chapter_${chapter}/${section}.html"
    outfile="$TEMP_DIR/${section}.html"
    
    curl -sL -o "$outfile" "$url"
    
    if [ -f "$outfile" ] && [ -s "$outfile" ]; then
        echo "  [$count/$total] ✓ ${section} (${name})"
    else
        echo "  [$count/$total] ✗ ${section} FAILED"
    fi
    
    # Be polite to the server
    sleep 0.2
done

echo ""
echo "=== Download Complete ==="
echo "Chapter HTML files: $RESEARCH_DIR"
echo "Individual sections: $TEMP_DIR"
echo ""
echo "Next: Run extract-statutes.js to convert HTML to markdown"
