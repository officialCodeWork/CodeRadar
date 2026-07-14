import { useForm } from "react-hook-form";

interface FormValues {
  email: string;
}

export function SignupForm() {
  const { register, handleSubmit } = useForm<FormValues>();

  // The real submit handler, wrapped by handleSubmit() in the JSX below.
  const onValid = (data: FormValues) =>
    fetch("/api/signup", { method: "POST", body: JSON.stringify(data) });

  return (
    <form onSubmit={handleSubmit(onValid)}>
      <h1>Create your account</h1>
      <input {...register("email")} placeholder="Email" />
      <button type="submit">Sign up</button>
    </form>
  );
}
