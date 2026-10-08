import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { InputGroup, Input } from 'rsuite';

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  id?: string;
}

// One toggle per field, not one per form — each password input manages its
// own reveal state, so showing "Current Password" never accidentally reveals
// "New Password" sitting right below it.
export const PasswordField: React.FC<PasswordFieldProps> = ({
  label, value, onChange, placeholder, required, autoFocus, id,
}) => {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
        {label}
      </label>
      <InputGroup inside className="w-full">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          required={required}
          autoFocus={autoFocus}
          value={value}
          onChange={(value) => onChange(value)}
          placeholder={placeholder}
        />
        <InputGroup.Button
          onClick={() => setVisible((v) => !v)}
          tabIndex={-1}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        >
          {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </InputGroup.Button>
      </InputGroup>
    </div>
  );
};
