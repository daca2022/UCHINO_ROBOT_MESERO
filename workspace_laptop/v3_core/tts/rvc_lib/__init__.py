"""RVC inference library for Auron voice conversion.
Applies dataclass monkey-patch for Python 3.12 + fairseq compatibility."""
import dataclasses

original_get_field = dataclasses._get_field

def _patched_get_field(cls, name, type_, kw_only=False):
    try:
        return original_get_field(cls, name, type_, kw_only)
    except ValueError as e:
        if 'mutable default' in str(e):
            f_type = cls.__annotations__.get(name) if hasattr(cls, '__annotations__') else None
            if f_type is not None and type(f_type) is type:
                new_f = dataclasses.field(default_factory=lambda t=f_type: t())
            else:
                new_f = dataclasses.field(default_factory=lambda: None)
            new_f.name = name
            new_f.type = type_
            new_f._field_type = dataclasses._FIELD
            return new_f
        raise

dataclasses._get_field = _patched_get_field
