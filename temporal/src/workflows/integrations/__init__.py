from .coupa import (
    CoupaSyncWorkflow,
    CoupaSyncWorkflowInput,
)
from .descartes import (
    DescartesSyncWorkflow,
    DescartesSyncWorkflowInput,
)
from .mulesoft import (
    MuleSoftInboundCallbackWorkflow,
    MuleSoftInboundCallbackWorkflowInput,
    MuleSoftOutboundWorkflow,
    MuleSoftOutboundWorkflowInput,
)
from .samsara import (
    SamsaraSyncWorkflow,
    SamsaraSyncWorkflowInput,
)

__all__ = [
    "CoupaSyncWorkflow",
    "CoupaSyncWorkflowInput",
    "DescartesSyncWorkflow",
    "DescartesSyncWorkflowInput",
    "MuleSoftInboundCallbackWorkflow",
    "MuleSoftInboundCallbackWorkflowInput",
    "MuleSoftOutboundWorkflow",
    "MuleSoftOutboundWorkflowInput",
    "SamsaraSyncWorkflow",
    "SamsaraSyncWorkflowInput",
]
