<#
  Blocks idle sleep while the AuditForge server process is alive, then exits.
  Started hidden by bg-start.ps1. It does not keep the display on, and it cannot
  stop a sleep the user starts manually (Start > Sleep, power button).
#>
param([Parameter(Mandatory = $true)][int]$ServerPid)

Add-Type -Namespace AuditForge -Name Power -MemberDefinition @"
[DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
"@

$ES_CONTINUOUS = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"

# The request belongs to this thread, and Wait-Process blocks this same thread,
# so the request is held until the server exits.
[AuditForge.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
try {
  Wait-Process -Id $ServerPid -ErrorAction SilentlyContinue
} finally {
  [AuditForge.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
}
