import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {useState} from 'react';
import {describe, expect, it, vi} from 'vitest';
import {Button} from './Button.js';
import {Chip} from './Chip.js';
import {Dialog} from './Dialog.js';
import {Input} from './Input.js';
import {Select} from './Select.js';
import {Switch} from './Switch.js';

describe('Button', () => {
  it('calls its handler when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Create story</Button>);

    await user.click(screen.getByRole('button', {name: 'Create story'}));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks while disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Create story
      </Button>,
    );

    await user.click(screen.getByRole('button', {name: 'Create story'}));

    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Input', () => {
  it('labels the field and announces its hint and error', async () => {
    const user = userEvent.setup();
    render(<Input label="Repository path" hint="Absolute path on this machine." error="That folder is gone." />);

    const field = screen.getByLabelText('Repository path');
    await user.type(field, '/srv/app');

    expect(field).toHaveValue('/srv/app');
    expect(field).toHaveAccessibleDescription('Absolute path on this machine. That folder is gone.');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Switch', () => {
  it('toggles on click', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch label="Autonomous" checked={on} onCheckedChange={setOn} />;
    }
    render(<Harness />);

    const control = screen.getByRole('switch', {name: 'Autonomous'});
    expect(control).toHaveAttribute('aria-checked', 'false');

    await user.click(control);

    expect(control).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Dialog', () => {
  it('opens from its trigger and closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Dialog trigger={<Button>New story</Button>} title="New story" description="Describe the work.">
        <p>Body</p>
      </Dialog>,
    );

    await user.click(screen.getByRole('button', {name: 'New story'}));

    const dialog = await screen.findByRole('dialog', {name: 'New story'});
    expect(dialog).toHaveTextContent('Describe the work.');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Chip', () => {
  it('renders its label', () => {
    render(<Chip tone="amber">In test</Chip>);

    expect(screen.getByText('In test')).toBeInTheDocument();
  });
});

describe('Select', () => {
  it('shows the selected option on its trigger', () => {
    render(
      <Select
        label="Model"
        value="claude-opus-5"
        onValueChange={() => {}}
        options={[
          {value: 'claude-opus-5', label: 'Claude Opus 5'},
          {value: 'gpt-5.1', label: 'GPT-5.1'},
        ]}
      />,
    );

    expect(screen.getByRole('combobox', {name: 'Model'})).toHaveTextContent('Claude Opus 5');
  });
});
